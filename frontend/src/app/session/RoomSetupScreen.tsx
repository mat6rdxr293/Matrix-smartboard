import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { DoorOpen, LogOut, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import type { Room, School } from "./types";

type RoomSetupScreenProps = {
  school: School;
  rooms: Room[];
  loading?: boolean;
  error?: string | null;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: (name: string) => void | Promise<void>;
  onLogout: () => void;
};

export default function RoomSetupScreen({
  school,
  rooms,
  loading = false,
  error,
  onSelectRoom,
  onCreateRoom,
  onLogout,
}: RoomSetupScreenProps) {
  const [name, setName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { tl } = useI18n();

  useEffect(() => {
    if (!createOpen) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) setCreateOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [createOpen, loading]);

  const closeCreate = () => {
    if (loading) return;
    setCreateOpen(false);
    setName("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized || loading) return;
    await onCreateRoom(normalized);
  };

  return (
    <main className="room-setup-shell session-shell grid-overlay">
      <section className="room-setup-content w-full">
        <header className="room-setup-header flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-accent">{school.name}</p>
            <h1 className="mt-1 text-3xl font-bold text-frost sm:text-[34px]">{tl("room_choose")}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-frost/55 sm:text-base">
              {tl("room_description")}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="accent"
              className="h-10 px-4"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={16} />
              {tl("room_new")}
            </Button>
            <Button variant="outline" className="h-10 px-4" onClick={onLogout}>
              <LogOut size={16} />
              {tl("room_logout")}
            </Button>
          </div>
        </header>

        <div className="room-setup-divider" />

        {rooms.length > 0 ? (
          <div className="room-grid">
            {rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className="room-card glass group"
                onClick={() => onSelectRoom(room)}
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
                  <DoorOpen size={24} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-frost/40">
                    {tl("room_label")}
                  </span>
                  <span className="mt-0.5 block truncate text-xl font-bold text-frost">{room.name}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="room-empty">
            <DoorOpen size={28} className="text-accent" />
            <div>
              <div className="text-sm font-semibold text-frost">{tl("room_empty_title")}</div>
              <div className="mt-1 text-xs leading-5 text-frost/45">{tl("room_empty_description")}</div>
            </div>
          </div>
        )}
      </section>

      {createOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[260] grid place-items-center bg-black/55 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCreate();
          }}
        >
          <form
            onSubmit={(event) => void submit(event)}
            className="glass w-full max-w-[480px] rounded-2xl border border-white/10 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.42)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-create-title"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="room-create-title" className="text-lg font-semibold text-frost">
                  {tl("room_modal_title")}
                </h2>
                <p className="mt-1 text-xs leading-5 text-frost/45">{tl("room_modal_description")}</p>
              </div>
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-frost/45 hover:bg-white/[0.06] hover:text-frost"
                onClick={closeCreate}
                aria-label={tl("cancel")}
                disabled={loading}
              >
                <X size={16} />
              </button>
            </div>

            <Input
              ref={inputRef}
              className="mt-4 h-11 bg-white/[0.045]"
              placeholder={tl("room_placeholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />

            {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" className="h-10 px-4" onClick={closeCreate} disabled={loading}>
                {tl("cancel")}
              </Button>
              <Button type="submit" variant="accent" className="h-10 px-4" disabled={loading || !name.trim()}>
                <Plus size={16} />
                {loading ? tl("room_saving") : tl("room_create")}
              </Button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </main>
  );
}
