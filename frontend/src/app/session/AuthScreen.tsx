import { FormEvent, useState } from "react";
import { ArrowRight, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
    <main className="session-shell auth-shell">
      <section className="auth-panel grid w-full max-w-[980px] overflow-hidden rounded-[22px] lg:grid-cols-[0.92fr_1.08fr]">
        <aside className="auth-intro flex min-h-[260px] flex-col justify-between border-b border-white/10 p-7 sm:p-9 lg:min-h-[520px] lg:border-b-0 lg:border-r">
          <div>
            <div className="flex items-center gap-2.5 text-[12px] font-semibold text-frost/55">
              <GraduationCap size={19} className="text-accent" />
              <span>Matrix Smartboard</span>
            </div>

            <div className="mt-14 max-w-[330px] lg:mt-24">
              <p className="text-[12px] font-medium text-frost/45">
                {mode === "login" ? "Вход в систему" : "Новая школа"}
              </p>
              <h1 className="mt-2 text-[34px] font-bold tracking-[-0.035em] text-frost sm:text-[40px]">
                Аккаунт школы
              </h1>
              <p className="mt-4 text-sm leading-6 text-frost/50">
                Один аккаунт для кабинетов, уроков и истории работы на доске.
              </p>
            </div>
          </div>

          <p className="mt-10 max-w-[300px] text-[11px] leading-5 text-frost/35">
            Авторизация привязывает эту доску к школе. Кабинет можно выбрать после входа.
          </p>
        </aside>

        <div className="flex min-h-[520px] items-center p-7 sm:p-10 lg:p-12">
          <div className="mx-auto w-full max-w-[420px]">
            <div className="mb-9 grid grid-cols-2 border-b border-white/10" role="tablist">
              {(["login", "register"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={mode === item}
                  className={cn(
                    "relative flex items-center justify-center px-2 pb-3 text-center text-[13px] font-semibold transition-colors",
                    mode === item ? "text-frost" : "text-frost/40 hover:text-frost/65"
                  )}
                  onClick={() => setMode(item)}
                >
                  {item === "login" ? "Войти" : "Регистрация"}
                  {mode === item && <span className="absolute inset-x-[18%] -bottom-px h-0.5 rounded-full bg-accent" />}
                </button>
              ))}
            </div>

            <form className="space-y-6" onSubmit={submit}>
              <label className="block">
                <span className="mb-2 block text-[12px] font-medium text-frost/60">Название школы</span>
                <Input
                  autoFocus
                  autoComplete="organization"
                  className="h-12 rounded-xl border-white/10 bg-transparent px-4 text-[14px] shadow-none focus:ring-1 focus:ring-accent/55"
                  placeholder="Например, ОСШГ №11"
                  value={schoolName}
                  onChange={(event) => setSchoolName(event.target.value)}
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-[12px] font-medium text-frost/60">Пароль</span>
                <Input
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="h-12 rounded-xl border-white/10 bg-transparent px-4 text-[14px] shadow-none focus:ring-1 focus:ring-accent/55"
                  placeholder="Минимум 8 символов"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              {error && (
                <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-3.5 py-3 text-[12px] text-danger">
                  {error}
                </p>
              )}

              <Button
                className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-[13px]"
                variant="accent"
                disabled={loading || !schoolName.trim() || password.length < 8}
              >
                <span>
                  {loading ? "Подождите…" : mode === "login" ? "Войти в школу" : "Создать аккаунт"}
                </span>
                {!loading && <ArrowRight size={16} className="shrink-0 transition-transform group-hover:translate-x-0.5" />}
              </Button>

              <p className="text-center text-[11px] leading-5 text-frost/35">
                {mode === "login"
                  ? "Нет аккаунта? Переключитесь на регистрацию выше."
                  : "Уже зарегистрированы? Вернитесь на вкладку входа."}
              </p>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
