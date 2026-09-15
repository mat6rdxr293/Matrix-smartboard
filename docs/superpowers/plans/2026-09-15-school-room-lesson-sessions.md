# School Room Lesson Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-service school accounts, board-to-room binding, curriculum-aware class and subject selection, and restorable per-room lesson histories containing every board operation and AI chat message.

**Architecture:** FastAPI owns authentication and lesson state in a local SQLite database. A new React `AppRoot` state machine handles authentication, room setup, grade/subject selection, resume modal, history, and the existing workspace. The existing workspace receives an explicit lesson context and sends board and AI activity under that lesson ID.

**Tech Stack:** Python 3.10+, FastAPI, stdlib `sqlite3`/`hashlib.scrypt`, pytest, React 18, TypeScript, Vite, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-09-15-school-room-lesson-sessions-design.md`

## Global Constraints

- One shared account per school; school names are unique after trimming, whitespace collapse, and case folding.
- Rooms and lessons are isolated by authenticated school on every server query.
- Grades are integers from 1 through 11.
- Grades 1–2: math, natural science, Kazakh, Russian.
- Grades 3–6: the same subjects plus English.
- Grades 7–11: algebra, geometry, physics, chemistry, biology, geography, Kazakh, Russian, English.
- A room has at most one active lesson; creating or resuming another completes the previous active lesson transactionally.
- Board operations `add`, `undo`, `redo`, and `clear` are retained in order and are idempotent by client operation ID.
- Runtime SQLite files, secrets, media, generated bundles, and visual brainstorming files remain ignored by Git.

---

### Task 1: Curriculum domain on backend and frontend

**Files:**
- Create: `backend/app/curriculum.py`
- Test: `backend/tests/test_curriculum.py`
- Create: `frontend/src/app/session/curriculum.ts`
- Create: `frontend/src/app/session/curriculum.test.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Interfaces:**
- Produces backend `subjects_for_grade(grade: int) -> tuple[str, ...]` and `is_subject_allowed(grade: int, subject_id: str) -> bool`.
- Produces frontend `getSubjectsForGrade(grade: Grade): SubjectOption[]`, `GRADES`, and `Grade`.

- [ ] **Step 1: Add failing backend boundary tests**

```python
def test_curriculum_boundaries():
    assert "english" not in subjects_for_grade(2)
    assert "english" in subjects_for_grade(3)
    assert "natural_science" in subjects_for_grade(6)
    assert "natural_science" not in subjects_for_grade(7)
    assert {"algebra", "geometry", "physics", "chemistry", "biology", "geography"} <= set(subjects_for_grade(7))
```

- [ ] **Step 2: Run `python -m pytest backend/tests/test_curriculum.py -q` and confirm import failure**

- [ ] **Step 3: Implement immutable grade groups and validation in `curriculum.py`**

```python
PRIMARY = ("math", "natural_science", "kazakh", "russian")
PRIMARY_WITH_ENGLISH = PRIMARY + ("english",)
SECONDARY = ("algebra", "geometry", "physics", "chemistry", "biology", "geography", "kazakh", "russian", "english")

def subjects_for_grade(grade: int) -> tuple[str, ...]:
    if not 1 <= grade <= 11:
        raise ValueError("grade must be between 1 and 11")
    return PRIMARY if grade <= 2 else PRIMARY_WITH_ENGLISH if grade <= 6 else SECONDARY
```

- [ ] **Step 4: Add Vitest and a frontend test asserting grades 2/3/6/7 produce the same IDs as backend**

- [ ] **Step 5: Implement localized subject metadata and `getSubjectsForGrade`**

- [ ] **Step 6: Run backend curriculum tests and `npm test -- --run`**

- [ ] **Step 7: Commit**

```bash
git add backend/app/curriculum.py backend/tests/test_curriculum.py frontend/package.json frontend/package-lock.json frontend/src/app/session/curriculum.ts frontend/src/app/session/curriculum.test.ts
git commit -m "feat: add Kazakhstan curriculum subject matrix"
```

### Task 2: SQLite school account and room persistence

**Files:**
- Create: `backend/app/school_store.py`
- Test: `backend/tests/test_school_store.py`
- Create: `backend/requirements-dev.txt`
- Modify: `backend/app/settings.py`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces `SchoolStore(path: Path)` with `register_school`, `authenticate_school`, `create_auth_session`, `school_for_token`, `delete_auth_session`, `list_rooms`, and `create_room`.
- School dict: `{id, name, createdAt}`. Room dict: `{id, schoolId, name, createdAt}`.

- [ ] **Step 1: Add `pytest==8.3.2` to `requirements-dev.txt` and install it into `.venv-mac`**

- [ ] **Step 2: Write failing store tests for normalized duplicate school names, correct/wrong passwords, token expiry, room uniqueness per school, and room isolation**

```python
store = SchoolStore(tmp_path / "practice.db")
school = store.register_school("  Школа   №11 ", "correct horse")
assert store.authenticate_school("школа №11", "correct horse")["id"] == school["id"]
assert store.authenticate_school("школа №11", "wrong") is None
```

- [ ] **Step 3: Run the store test and confirm `SchoolStore` is missing**

- [ ] **Step 4: Implement schema creation, per-call SQLite connections, foreign keys, WAL mode, scrypt password hashes, hashed auth tokens, and room CRUD**

```python
password_hash = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
token = secrets.token_urlsafe(32)
token_hash = hashlib.sha256(token.encode()).hexdigest()
```

- [ ] **Step 5: Add `PRACTICE_DB_PATH` and `SCHOOL_SESSION_DAYS` settings with defaults `backend/app/data/practice.db` and `30`**

- [ ] **Step 6: Run `python -m pytest backend/tests/test_school_store.py -q`**

- [ ] **Step 7: Commit**

```bash
git add backend/app/school_store.py backend/tests/test_school_store.py backend/requirements-dev.txt backend/app/settings.py backend/.env.example
git commit -m "feat: persist school accounts and rooms"
```

### Task 3: School authentication and room API

**Files:**
- Create: `backend/app/school_routes.py`
- Test: `backend/tests/test_school_api.py`
- Modify: `backend/app/main.py`

**Interfaces:**
- Produces the auth endpoints `/api/auth/register-school`, `/api/auth/login-school`, `/api/auth/logout`, `/api/auth/session`.
- Produces `GET /api/rooms` and `POST /api/rooms`.
- Produces `require_school(request: Request) -> dict` for later lesson endpoints.

- [ ] **Step 1: Write failing TestClient cases for registration cookie, login, logout, unauthenticated 401, duplicate registration 409, room creation, and cross-school isolation**

```python
response = client.post("/api/auth/register-school", json={"school_name": "Школа №11", "password": "password11"})
assert response.status_code == 201
assert response.cookies.get("school_session")
assert client.post("/api/rooms", json={"name": "20"}).status_code == 201
```

- [ ] **Step 2: Run the API test and confirm 404 responses**

- [ ] **Step 3: Implement Pydantic payloads, cookie helpers, store lookup through `request.app.state.school_store`, and the six routes**

- [ ] **Step 4: Initialize `app.state.school_store` and include the router before the static frontend mount in `main.py`**

- [ ] **Step 5: Run `python -m pytest backend/tests/test_school_api.py -q`**

- [ ] **Step 6: Commit**

```bash
git add backend/app/school_routes.py backend/app/main.py backend/tests/test_school_api.py
git commit -m "feat: expose school authentication and rooms API"
```

### Task 4: Lesson lifecycle, history, board log, and chat persistence

**Files:**
- Modify: `backend/app/school_store.py`
- Modify: `backend/app/school_routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_lesson_sessions.py`

**Interfaces:**
- Adds `create_lesson`, `active_lesson`, `list_lessons`, `get_lesson`, `complete_lesson`, `resume_lesson`, `append_board_operations`, `board_state`, `append_chat_message`, and `chat_messages` to `SchoolStore`.
- Produces lesson/board/chat endpoints from the specification.

- [ ] **Step 1: Write failing tests for invalid grade/subject pairs, automatic completion, manual completion, resume, school isolation, and per-room histories**

- [ ] **Step 2: Add a failing board test with duplicate IDs and `add → undo → redo → clear`; assert the stored sequence is exact and the duplicate is ignored**

- [ ] **Step 3: Add a failing chat test asserting student, assistant, and error messages return in chronological order for one lesson only**

- [ ] **Step 4: Run `python -m pytest backend/tests/test_lesson_sessions.py -q` and confirm missing methods/routes**

- [ ] **Step 5: Add lesson, board operation, snapshot, and chat tables plus transactional store methods**

Board operations use this server contract:

```json
{"operations":[{"client_operation_id":"uuid","op":"add","stroke":{"points":[{"x":1,"y":2},{"x":3,"y":4}],"color":"#fff","width":3,"mode":"draw"},"ts":1789490000000}]}
```

- [ ] **Step 6: Implement lesson endpoints and ensure every lookup filters both object ID and authenticated `school_id`**

- [ ] **Step 7: Extend `AiRequest` with `lesson_id` and `client_message_id`; when present, persist the user request before model execution and persist either assistant response or error afterward**

- [ ] **Step 8: Run all backend tests**

- [ ] **Step 9: Commit**

```bash
git add backend/app/school_store.py backend/app/school_routes.py backend/app/main.py backend/tests/test_lesson_sessions.py
git commit -m "feat: persist room lesson histories"
```

### Task 5: Frontend session API and school/room entry screens

**Files:**
- Create: `frontend/src/app/session/types.ts`
- Create: `frontend/src/app/session/api.ts`
- Create: `frontend/src/app/session/AuthScreen.tsx`
- Create: `frontend/src/app/session/RoomSetupScreen.tsx`
- Test: `frontend/src/app/session/api.test.ts`

**Interfaces:**
- Produces typed `School`, `Room`, `Lesson`, `LessonSummary`, `ChatMessage`, and `BoardOperation`.
- Produces `sessionApi` methods corresponding one-to-one with backend routes.
- Screens receive data and callbacks only; they do not call fetch directly.

- [ ] **Step 1: Write failing fetch-contract tests for register, login, session lookup, room list, and room creation with `credentials: "same-origin"`**

- [ ] **Step 2: Run `npm test -- --run src/app/session/api.test.ts` and confirm missing module failure**

- [ ] **Step 3: Implement typed response parsing and an `ApiError` carrying HTTP status/detail**

- [ ] **Step 4: Build the responsive auth screen with login/register tabs, school name, password, loading state, and inline errors**

- [ ] **Step 5: Build room setup with existing room cards, a new-room input, and disabled submit while empty/loading**

- [ ] **Step 6: Run frontend tests and `npm run build`**

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/session/types.ts frontend/src/app/session/api.ts frontend/src/app/session/api.test.ts frontend/src/app/session/AuthScreen.tsx frontend/src/app/session/RoomSetupScreen.tsx
git commit -m "feat: add school and room entry flow"
```

### Task 6: Grade, subject, resume modal, and room history UI

**Files:**
- Create: `frontend/src/app/session/GradePicker.tsx`
- Create: `frontend/src/app/session/SubjectPicker.tsx`
- Create: `frontend/src/app/session/ResumeLessonModal.tsx`
- Create: `frontend/src/app/session/LessonHistory.tsx`
- Create: `frontend/src/app/session/flow.test.tsx`

**Interfaces:**
- `GradePicker({school, room, onSelectGrade, onOpenHistory, onLogout, onChangeRoom})`.
- `SubjectPicker({grade, locale, onSelectSubject, onBack})`.
- `ResumeLessonModal({lesson, onResume, onStartNew})`.
- `LessonHistory({room, lessons, onOpenLesson, onBack})`.

- [ ] **Step 1: Add React Testing Library and jsdom, then write failing interaction tests for selecting grade 6/7, the resume modal buttons, and history selection**

- [ ] **Step 2: Run `npm test -- --run src/app/session/flow.test.tsx` and confirm missing component failures**

- [ ] **Step 3: Implement the four components using the existing `glass`, `accent`, `ink`, and `frost` tokens and keyboard-accessible buttons/dialog semantics**

- [ ] **Step 4: Run the component tests and `npm run build`**

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/app/session/GradePicker.tsx frontend/src/app/session/SubjectPicker.tsx frontend/src/app/session/ResumeLessonModal.tsx frontend/src/app/session/LessonHistory.tsx frontend/src/app/session/flow.test.tsx
git commit -m "feat: add class subject and lesson history screens"
```

### Task 7: AppRoot state machine and lesson-aware workspace

**Files:**
- Create: `frontend/src/app/AppRoot.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/app/layout/TopBar.tsx`
- Modify: `frontend/src/app/subjects/subjectConfig.ts`
- Modify: `frontend/src/app/board/replayApi.ts`
- Modify: `frontend/src/app/ai/api.ts`
- Test: `frontend/src/app/AppRoot.test.tsx`

**Interfaces:**
- `AppRoot` owns states `loading | auth | roomSetup | grade | subject | history | lesson`.
- Existing `App` becomes `LessonWorkspace({school, room, lesson, onComplete, onOpenHistory, onChangeRoom})`.
- Board API requires `lesson.id`; AI API requires `lesson.id` and a client message UUID.

- [ ] **Step 1: Write a failing AppRoot test for boot → auth, authenticated boot → room setup, bound room → grade with resume modal, resume → lesson, and start new → complete + grade**

- [ ] **Step 2: Run the focused test and confirm `AppRoot` is missing**

- [ ] **Step 3: Implement AppRoot bootstrap, school-scoped local room binding, screen transitions, active lesson lookup, and modal decisions**

- [ ] **Step 4: Add `math`, `natural_science`, and `english` subject metadata/default exercises and accept explicit `subjectId`/`grade`/`lessonId` in the workspace**

- [ ] **Step 5: Replace subject-level board calls with lesson board load/append calls; generate `crypto.randomUUID()` for each queued operation and key the backup queue by school/room/lesson**

- [ ] **Step 6: Load saved chat on lesson entry and send `lesson_id` plus client message ID on every AI request**

- [ ] **Step 7: Add school, room, grade, subject, `Завершить урок`, `История`, and `Сменить кабинет` controls to TopBar without removing existing lesson controls**

- [ ] **Step 8: Mount `AppRoot` from `main.tsx`, run focused tests, all frontend tests, and build**

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/AppRoot.tsx frontend/src/app/AppRoot.test.tsx frontend/src/app/App.tsx frontend/src/main.tsx frontend/src/app/layout/TopBar.tsx frontend/src/app/subjects/subjectConfig.ts frontend/src/app/board/replayApi.ts frontend/src/app/ai/api.ts
git commit -m "feat: connect lesson sessions to workspace"
```

### Task 8: End-to-end verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `backend/README.md`
- Modify: `scripts/test.ps1`
- Create: `scripts/test.sh`

**Interfaces:**
- Produces one macOS/Linux verification command: `./scripts/test.sh`.

- [ ] **Step 1: Write `scripts/test.sh` to install backend dev requirements, run all backend tests, run frontend tests, and build the frontend**

- [ ] **Step 2: Document registration, cabinet binding, lesson lifecycle, database location, backup responsibility, and test commands**

- [ ] **Step 3: Run `./scripts/test.sh` and require zero failing tests**

- [ ] **Step 4: Copy the successful `frontend/dist` output into `backend/app/static` and verify the active index references the new bundle**

- [ ] **Step 5: Start the application, register two schools, create rooms 19/20, verify isolation, create a grade-6 natural science lesson and grade-7 physics lesson, draw/undo/redo/clear, send an AI request or recorded test message, refresh, resume, and open both histories**

- [ ] **Step 6: Visually inspect auth, room setup, grade picker, subject picker, resume modal, history, and workspace at desktop and narrow widths**

- [ ] **Step 7: Commit**

```bash
git add README.md backend/README.md scripts/test.sh scripts/test.ps1
git commit -m "docs: document school lesson sessions"
```
