import { useCallback, useEffect, useState } from "react";
import LessonWorkspace from "./App";
import AuthScreen from "./session/AuthScreen";
import GradePicker from "./session/GradePicker";
import LessonHistory from "./session/LessonHistory";
import ResumeLessonModal from "./session/ResumeLessonModal";
import RoomSetupScreen from "./session/RoomSetupScreen";
import SubjectPicker from "./session/SubjectPicker";
import { sessionApi } from "./session/api";
import type { CurriculumSubjectId, Grade } from "./session/curriculum";
import type { Lesson, LessonSummary, Room, School } from "./session/types";
import { useI18n } from "@/i18n";

type View = "loading" | "auth" | "roomSetup" | "grade" | "subject" | "history" | "lesson";

const roomBindingKey = (schoolId: string) => `practice.room.${schoolId}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String((error as { detail?: unknown })?.detail || "Не удалось выполнить действие");

export default function AppRoot() {
  const { locale } = useI18n();
  const [view, setView] = useState<View>("loading");
  const [school, setSchool] = useState<School | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<Lesson | null>(null);
  const [history, setHistory] = useState<LessonSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enterRoom = useCallback(async (currentSchool: School, selectedRoom: Room, checkActive = true) => {
    localStorage.setItem(roomBindingKey(currentSchool.id), selectedRoom.id);
    setRoom(selectedRoom);
    setGrade(null);
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

  const startLesson = async (subjectId: CurriculumSubjectId) => {
    if (!room || !grade) return;
    setBusy(true);
    setError(null);
    try {
      const created = await sessionApi.createLesson(room.id, grade, subjectId);
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
      setLesson(resumed); setResumeCandidate(null); setView("lesson");
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  };

  const finishLesson = async () => {
    if (!lesson) return;
    setBusy(true);
    try {
      await sessionApi.completeLesson(lesson.id);
      setLesson(null); setGrade(null); setView("grade");
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
  if (view === "subject" && grade) {
    return <SubjectPicker grade={grade} locale={locale} loading={busy} error={error} onSelectSubject={(subjectId) => void startLesson(subjectId)} onBack={() => { setError(null); setView("grade"); }} />;
  }
  if (view === "lesson" && lesson) {
    return <LessonWorkspace school={school} room={room} lesson={lesson} onComplete={() => void finishLesson()} onOpenHistory={() => void openHistory()} onChangeRoom={() => { setLesson(null); setView("roomSetup"); }} />;
  }
  return (
    <>
      <GradePicker school={school} room={room} onSelectGrade={(selected) => { setGrade(selected); setError(null); setView("subject"); }} onOpenHistory={() => void openHistory()} onLogout={() => void logout()} onChangeRoom={() => setView("roomSetup")} />
      {resumeCandidate && (
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
    </>
  );
}
