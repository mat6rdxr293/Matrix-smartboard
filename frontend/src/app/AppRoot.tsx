import { useCallback, useEffect, useState } from "react";
import LessonWorkspace from "./App";
import AuthScreen from "./session/AuthScreen";
import GradePicker from "./session/GradePicker";
import LessonHistory from "./session/LessonHistory";
import ResumeLessonModal from "./session/ResumeLessonModal";
import RoomSetupScreen from "./session/RoomSetupScreen";
import SubjectPicker from "./session/SubjectPicker";
import BoardProfilePicker from "./session/BoardProfilePicker";
import { sessionApi } from "./session/api";
import type { CurriculumSubjectId, Grade } from "./session/curriculum";
import type { Lesson, LessonSummary, Room, School } from "./session/types";
import { inferBoardProfileForSubject, isBoardProfile, type BoardProfile } from "@/app/board/boardProfiles";
import { useI18n } from "@/i18n";
import { AnimatePresence, motion } from "framer-motion";

type View = "loading" | "auth" | "roomSetup" | "grade" | "subject" | "boardProfile" | "history" | "lesson";

const roomBindingKey = (schoolId: string) => `practice.room.${schoolId}`;
const boardProfileKey = (lessonId: string) => `practice.lesson.${lessonId}.boardProfile`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String((error as { detail?: unknown })?.detail || "Не удалось выполнить действие");

export default function AppRoot() {
  const { locale } = useI18n();
  const [view, setView] = useState<View>("loading");
  const [school, setSchool] = useState<School | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [selectedSubjectId, setSelectedSubjectId] = useState<CurriculumSubjectId | null>(null);
  const [boardProfile, setBoardProfile] = useState<BoardProfile>("universal");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<Lesson | null>(null);
  const [history, setHistory] = useState<LessonSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entryDirection, setEntryDirection] = useState<1 | -1>(1);

  const enterRoom = useCallback(async (currentSchool: School, selectedRoom: Room, checkActive = true) => {
    localStorage.setItem(roomBindingKey(currentSchool.id), selectedRoom.id);
    setRoom(selectedRoom);
    setGrade(null);
    setSelectedSubjectId(null);
    setLesson(null);
    setView("grade");
    if (checkActive) {
      const active = await sessionApi.activeLesson(selectedRoom.id);
      setResumeCandidate(active);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const currentSchool = await sessionApi.currentSchool();
        const availableRooms = await sessionApi.listRooms();
        if (cancelled) return;
        setSchool(currentSchool);
        setRooms(availableRooms);
        const savedRoomId = localStorage.getItem(roomBindingKey(currentSchool.id));
        const savedRoom = availableRooms.find((item) => item.id === savedRoomId);
        if (!savedRoom) {
          if (savedRoomId) localStorage.removeItem(roomBindingKey(currentSchool.id));
          setView("roomSetup");
          return;
        }
        await enterRoom(currentSchool, savedRoom);
      } catch {
        if (!cancelled) setView("auth");
      }
    };
    void boot();
    return () => { cancelled = true; };
  }, [enterRoom]);

  const authenticate = async (mode: "login" | "register", schoolName: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const currentSchool = mode === "login"
        ? await sessionApi.login(schoolName, password)
        : await sessionApi.register(schoolName, password);
      const availableRooms = await sessionApi.listRooms();
      setSchool(currentSchool);
      setRooms(availableRooms);
      const saved = availableRooms.find((item) => item.id === localStorage.getItem(roomBindingKey(currentSchool.id)));
      if (saved) await enterRoom(currentSchool, saved);
      else setView("roomSetup");
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  };

  const createRoom = async (name: string) => {
    if (!school) return;
    setBusy(true);
    setError(null);
    try {
      const created = await sessionApi.createRoom(name);
      setRooms((current) => [...current, created]);
      await enterRoom(school, created, false);
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try { await sessionApi.logout(); } finally {
      setSchool(null); setRoom(null); setLesson(null); setResumeCandidate(null); setError(null); setView("auth"); setBusy(false);
    }
  };

  const startLesson = async (profile: BoardProfile) => {
    if (!room || !grade || !selectedSubjectId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await sessionApi.createLesson(room.id, grade, selectedSubjectId);
      setBoardProfile(profile);
      localStorage.setItem(boardProfileKey(created.id), profile);
      setLesson(created);
      setView("lesson");
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async () => {
    if (!room) return;
    setBusy(true); setError(null); setView("history");
    try { setHistory(await sessionApi.listLessons(room.id)); }
    catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const openSavedLesson = async (saved: Lesson) => {
    setBusy(true); setError(null);
    try {
      const resumed = await sessionApi.resumeLesson(saved.id);
      const storedProfile = localStorage.getItem(boardProfileKey(saved.id));
      setBoardProfile(isBoardProfile(storedProfile) ? storedProfile : inferBoardProfileForSubject(saved.subjectId));
      setLesson(resumed); setResumeCandidate(null); setView("lesson");
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const finishLesson = async () => {
    if (!lesson) return;
    setBusy(true);
    try {
      await sessionApi.completeLesson(lesson.id);
      setLesson(null); setGrade(null); setSelectedSubjectId(null); setView("grade");
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  if (view === "loading") {
    return <main className="session-shell grid-overlay"><div className="text-sm font-semibold text-frost/60">Загрузка школьной доски…</div></main>;
  }
  if (view === "auth" || !school) {
    return <AuthScreen loading={busy} error={error} onLogin={(name, password) => authenticate("login", name, password)} onRegister={(name, password) => authenticate("register", name, password)} />;
  }
  if (view === "roomSetup" || !room) {
    return <RoomSetupScreen school={school} rooms={rooms} loading={busy} error={error} onSelectRoom={(selected) => void enterRoom(school, selected)} onCreateRoom={createRoom} onLogout={() => void logout()} />;
  }
  if (view === "history") {
    return <LessonHistory room={room} lessons={history} loading={busy} error={error} onOpenLesson={(saved) => void openSavedLesson(saved)} onBack={() => setView("grade")} />;
  }
  if (view === "lesson" && lesson) {
    return <LessonWorkspace school={school} room={room} lesson={lesson} boardProfile={boardProfile} onComplete={() => void finishLesson()} onOpenHistory={() => void openHistory()} onChangeRoom={() => { setLesson(null); setView("roomSetup"); }} />;
  }

  const entryTransition = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };
  const entryVariants = {
    enter: (direction: 1 | -1) => ({ opacity: 0, x: direction > 0 ? 56 : -56 }),
    center: { opacity: 1, x: 0 },
    exit: (direction: 1 | -1) => ({ opacity: 0, x: direction > 0 ? -56 : 56 }),
  };

  return (
    <div className="relative h-full overflow-hidden">
      <AnimatePresence mode="wait" initial={false} custom={entryDirection}>
        {view === "boardProfile" && grade && selectedSubjectId ? (
          <motion.div
            key="board-profile-picker"
            custom={entryDirection}
            variants={entryVariants}
            className="h-full"
            initial="enter"
            animate="center"
            exit="exit"
            transition={entryTransition}
          >
            <BoardProfilePicker
              onSelectProfile={(profile) => void startLesson(profile)}
              onBack={() => { setEntryDirection(-1); setError(null); setView("subject"); }}
            />
          </motion.div>
        ) : view === "subject" && grade ? (
          <motion.div
            key="subject-picker"
            custom={entryDirection}
            variants={entryVariants}
            className="h-full"
            initial="enter"
            animate="center"
            exit="exit"
            transition={entryTransition}
          >
            <SubjectPicker
              grade={grade}
              locale={locale}
              loading={busy}
              error={error}
              onSelectSubject={(subjectId) => {
                setEntryDirection(1);
                setSelectedSubjectId(subjectId);
                setError(null);
                setView("boardProfile");
              }}
              onBack={() => { setEntryDirection(-1); setSelectedSubjectId(null); setError(null); setView("grade"); }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="grade-picker"
            custom={entryDirection}
            variants={entryVariants}
            className="h-full"
            initial="enter"
            animate="center"
            exit="exit"
            transition={entryTransition}
          >
            <GradePicker
              school={school}
              room={room}
              onSelectGrade={(selected) => { setEntryDirection(1); setGrade(selected); setSelectedSubjectId(null); setError(null); setView("subject"); }}
              onOpenHistory={() => void openHistory()}
              onLogout={() => void logout()}
              onChangeRoom={() => setView("roomSetup")}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {view !== "subject" && view !== "boardProfile" && resumeCandidate && (
        <ResumeLessonModal
          lesson={resumeCandidate}
          loading={busy}
          onResume={() => void openSavedLesson(resumeCandidate)}
          onStartNew={() => {
            setBusy(true);
            void sessionApi.completeLesson(resumeCandidate.id)
              .then(() => setResumeCandidate(null))
              .catch((nextError) => setError(errorText(nextError)))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}
