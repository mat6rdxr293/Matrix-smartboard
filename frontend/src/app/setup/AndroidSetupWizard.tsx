import { useState, type ReactNode } from "react";
import { ChevronLeft, LoaderCircle, Network, ServerCog, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { finishAndroidSetup, SshProvisioner, testServer } from "./androidSetup";

type Mode = "choose" | "existing" | "ssh";

type Props = { onDone: () => void };

export default function AndroidSetupWizard({ onDone }: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [serverUrl, setServerUrl] = useState("");
  const [host, setHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [backendPort, setBackendPort] = useState("8001");
  const [installLocalAi, setInstallLocalAi] = useState(true);
  const [fingerprint, setFingerprint] = useState("");
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  const resetError = () => setError(null);

  const connectExisting = async () => {
    setBusy(true); resetError();
    try {
      const result = await testServer(serverUrl);
      finishAndroidSetup(result.serverUrl);
      onDone();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  };

  const inspectSsh = async () => {
    setBusy(true); resetError(); setFingerprint(""); setFingerprintConfirmed(false);
    try {
      const result = await SshProvisioner.inspectHost({
        host: host.trim(),
        port: Number(sshPort),
        username: username.trim(),
        password,
      });
      setFingerprint(result.fingerprint);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    setBusy(true); resetError(); setLines([]);
    let handle: Awaited<ReturnType<typeof SshProvisioner.addListener>> | null = null;
    try {
      handle = await SshProvisioner.addListener("provisionProgress", ({ line }) => {
        if (!line.trim()) return;
        setLines((current) => [...current.slice(-120), line]);
      });
      const result = await SshProvisioner.provisionServer({
        host: host.trim(),
        port: Number(sshPort),
        username: username.trim(),
        password,
        sudoPassword: sudoPassword || password,
        expectedFingerprint: fingerprint,
        backendPort: Number(backendPort),
        installLocalAi,
      });
      const checked = await testServer(result.serverUrl);
      finishAndroidSetup(checked.serverUrl);
      setPassword("");
      setSudoPassword("");
      onDone();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      await handle?.remove();
      setBusy(false);
    }
  };

  return (
    <main className="session-shell grid-overlay items-center justify-center p-6">
      <section className="glass w-full max-w-[940px] overflow-hidden rounded-[24px] border border-white/10 shadow-soft">
        <div className="border-b border-white/10 px-7 py-6 sm:px-9">
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-accent">Matrix Smartboard</div>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.03em] text-frost">Первая настройка</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-frost/50">Подключите приложение к существующему серверу или установите сервер автоматически по SSH.</p>
        </div>

        <div className="p-7 sm:p-9">
          {mode === "choose" && (
            <div className="grid gap-4 md:grid-cols-2">
              <button type="button" onClick={() => setMode("existing")} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-left transition hover:border-accent/35 hover:bg-white/[0.055]">
                <Network size={28} className="text-accent" />
                <div className="mt-5 text-lg font-semibold text-frost">Подключиться к серверу</div>
                <div className="mt-2 text-sm leading-6 text-frost/45">Сервер Matrix Smartboard уже установлен. Достаточно указать его адрес.</div>
              </button>
              <button type="button" onClick={() => setMode("ssh")} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-left transition hover:border-accent/35 hover:bg-white/[0.055]">
                <ServerCog size={28} className="text-accent" />
                <div className="mt-5 text-lg font-semibold text-frost">Настроить сервер по SSH</div>
                <div className="mt-2 text-sm leading-6 text-frost/45">Приложение подключится к серверу Debian/Ubuntu, установит Matrix Smartboard из GitHub и запустит его как системную службу.</div>
              </button>
            </div>
          )}

          {mode === "existing" && (
            <div className="mx-auto max-w-xl">
              <Back onClick={() => setMode("choose")} />
              <h2 className="mt-5 text-xl font-semibold">Готовый сервер</h2>
              <label className="mt-6 block text-xs font-medium text-frost/55">Адрес сервера</label>
              <Input className="mt-2 h-12" placeholder="192.168.1.50:8001" value={serverUrl} onChange={(event) => { setServerUrl(event.target.value); resetError(); }} />
              {error && <ErrorBox text={error} />}
              <Button variant="accent" className="mt-6 h-11 w-full" disabled={busy || !serverUrl.trim()} onClick={() => void connectExisting()}>
                {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />Проверка...</> : "Проверить и подключить"}
              </Button>
            </div>
          )}

          {mode === "ssh" && (
            <div>
              <Back onClick={() => setMode("choose")} />
              <div className="mt-5 grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
                <div>
                  <h2 className="text-xl font-semibold">SSH-сервер</h2>
                  <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_120px]">
                    <Field label="IP или домен"><Input placeholder="192.168.1.10" value={host} onChange={(e) => { setHost(e.target.value); setFingerprint(""); resetError(); }} /></Field>
                    <Field label="SSH порт"><Input inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value)} /></Field>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="Пользователь"><Input value={username} onChange={(e) => { setUsername(e.target.value); setFingerprint(""); }} /></Field>
                    <Field label="SSH пароль"><Input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setFingerprint(""); }} /></Field>
                  </div>
                  {username !== "root" && <div className="mt-4"><Field label="Пароль sudo (если отличается)"><Input type="password" value={sudoPassword} onChange={(e) => setSudoPassword(e.target.value)} placeholder="По умолчанию используется SSH пароль" /></Field></div>}
                  <div className="mt-4"><Field label="Порт Matrix Smartboard"><Input inputMode="numeric" value={backendPort} onChange={(e) => setBackendPort(e.target.value)} /></Field></div>

                  <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4">
                    <input type="checkbox" className="mt-1" checked={installLocalAi} onChange={(e) => setInstallLocalAi(e.target.checked)} />
                    <span><span className="block text-sm font-medium">Установить локальный ИИ</span><span className="mt-1 block text-xs leading-5 text-frost/40">Установит Ollama, Qwen 2.5 7B и Qwen 2.5 VL 3B. Загрузка займёт больше времени и требует достаточно памяти на сервере.</span></span>
                  </label>

                  {!fingerprint ? (
                    <Button variant="accent" className="mt-6 h-11 w-full" disabled={busy || !host.trim() || !username.trim() || !password} onClick={() => void inspectSsh()}>
                      {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />Подключение...</> : "Проверить SSH"}
                    </Button>
                  ) : (
                    <div className="mt-6 rounded-xl border border-accent/20 bg-accent/[0.06] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-accent" />Ключ сервера</div>
                      <code className="mt-3 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{fingerprint}</code>
                      <label className="mt-3 flex items-center gap-2 text-xs text-frost/60"><input type="checkbox" checked={fingerprintConfirmed} onChange={(e) => setFingerprintConfirmed(e.target.checked)} />Подтверждаю этот SSH-сервер</label>
                      <Button variant="accent" className="mt-4 h-11 w-full" disabled={busy || !fingerprintConfirmed} onClick={() => void provision()}>
                        {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />Установка...</> : "Установить Matrix Smartboard"}
                      </Button>
                    </div>
                  )}
                  {error && <ErrorBox text={error} />}
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold text-frost/60"><Terminal size={15} />Ход установки</div>
                  <div className="mt-3 h-[390px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/20 p-3 font-mono text-[10px] leading-5 text-frost/55">
                    {lines.length ? lines.join("\n") : "После подтверждения здесь появится журнал установки."}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-frost/45 hover:text-frost"><ChevronLeft size={15} />Назад</button>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-medium text-frost/55">{label}</span>{children}</label>;
}
function ErrorBox({ text }: { text: string }) {
  return <div className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-xs text-danger">{text}</div>;
}
