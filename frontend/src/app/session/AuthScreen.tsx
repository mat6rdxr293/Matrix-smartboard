import { FormEvent, useState } from "react";
import { GraduationCap, LogIn, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AuthMode = "login" | "register";

type AuthScreenProps = {
  loading?: boolean;
  error?: string | null;
  onLogin: (schoolName: string, password: string) => void | Promise<void>;
  onRegister: (schoolName: string, password: string) => void | Promise<void>;
};

export default function AuthScreen({ loading = false, error, onLogin, onRegister }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [schoolName, setSchoolName] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!schoolName.trim() || password.length < 8 || loading) return;
    const handler = mode === "login" ? onLogin : onRegister;
    void handler(schoolName.trim(), password);
  };

  return (
    <main className="session-shell grid-overlay">
      <section className="glass w-full max-w-lg rounded-[28px] p-7 shadow-soft sm:p-9">
        <div className="mb-7 flex items-center gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent text-accentText"><GraduationCap size={30} /></div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Умная доска</p>
            <h1 className="text-2xl font-bold text-frost">Аккаунт школы</h1>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 rounded-xl border border-white/10 bg-white/5 p-1" role="tablist">
          {(["login", "register"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${mode === item ? "bg-accent text-accentText" : "text-frost/65 hover:text-frost"}`}
              onClick={() => setMode(item)}
            >
              {item === "login" ? "Войти" : "Регистрация"}
            </button>
          ))}
        </div>

        <form className="space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium text-frost/75">
            Название школы
            <Input
              autoFocus
              autoComplete="organization"
              className="mt-2 h-12 bg-white/5"
              placeholder="Например, Школа №11"
              value={schoolName}
              onChange={(event) => setSchoolName(event.target.value)}
            />
          </label>
          <label className="block text-sm font-medium text-frost/75">
            Пароль
            <Input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="mt-2 h-12 bg-white/5"
              placeholder="Минимум 8 символов"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <Button className="h-12 w-full" variant="accent" disabled={loading || !schoolName.trim() || password.length < 8}>
            {mode === "login" ? <LogIn size={18} className="mr-2" /> : <UserPlus size={18} className="mr-2" />}
            {loading ? "Подождите…" : mode === "login" ? "Войти в школу" : "Создать аккаунт школы"}
          </Button>
        </form>
      </section>
    </main>
  );
}
