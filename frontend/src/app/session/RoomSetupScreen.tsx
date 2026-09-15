import { FormEvent, useState } from "react";
import { DoorOpen, LogOut, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export default function RoomSetupScreen({ school, rooms, loading = false, error, onSelectRoom, onCreateRoom, onLogout }: RoomSetupScreenProps) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || loading) return;
    void onCreateRoom(name.trim());
  };

  return (
    <main className="session-shell grid-overlay items-start py-10 sm:items-center">
      <section className="w-full max-w-4xl">
        <header className="mb-7 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-accent">{school.name}</p>
            <h1 className="mt-1 text-3xl font-bold text-frost">Выберите кабинет</h1>
            <p className="mt-2 text-frost/55">На этой доске будет открываться отдельная история уроков выбранного кабинета.</p>
          </div>
          <Button variant="outline" onClick={onLogout}><LogOut size={16} className="mr-2" />Выйти</Button>
        </header>

        {rooms.length > 0 && (
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => (
              <button key={room.id} type="button" className="glass group flex items-center gap-4 rounded-2xl p-5 text-left transition hover:-translate-y-0.5 hover:border-accent/60" onClick={() => onSelectRoom(room)}>
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent/15 text-accent"><DoorOpen size={23} /></span>
                <span><span className="block text-xs uppercase tracking-wide text-frost/45">Кабинет</span><span className="text-xl font-bold text-frost">{room.name}</span></span>
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} className="glass rounded-2xl p-5">
          <label className="mb-3 block text-sm font-semibold text-frost">Добавить новый кабинет</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input className="h-11 flex-1 bg-white/5" placeholder="Номер или название, например 20" value={name} onChange={(event) => setName(event.target.value)} />
            <Button variant="accent" className="h-11" disabled={loading || !name.trim()}><Plus size={17} className="mr-2" />{loading ? "Сохранение…" : "Создать и выбрать"}</Button>
          </div>
          {error && <p role="alert" className="mt-3 text-sm text-rose-200">{error}</p>}
        </form>
      </section>
    </main>
  );
}
