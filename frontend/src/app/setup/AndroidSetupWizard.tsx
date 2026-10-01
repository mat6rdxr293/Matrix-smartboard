import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, LoaderCircle, Network, ServerCog, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  discoverServers,
  finishAndroidSetup,
  probeServerIdentity,
  SshProvisioner,
  testServer,
  trustServerIdentity,
  type DiscoveredServer,
  type ServerStatus,
} from "./androidSetup";

type Mode = "choose" | "existing" | "ssh";
type Props = { onDone: () => void };
type PendingTrust = {
  serverUrl: string;
  serverId: string;
  pin: string;
  status: ServerStatus;
};

export default function AndroidSetupWizard({ onDone }: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [serverUrl, setServerUrl] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [manualFallbackVisible, setManualFallbackVisible] = useState(false);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [host, setHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [backendPort, setBackendPort] = useState("8443");
  const [installLocalAi, setInstallLocalAi] = useState(true);
  const [fingerprint, setFingerprint] = useState("");
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const scanRunRef = useRef(0);

  const resetError = () => setError(null);

  const scanServers = async () => {
    const runId = ++scanRunRef.current;
    setDiscovering(true);
    resetError();

    const mergeDiscovered = (next: DiscoveredServer[]) => {
      if (runId !== scanRunRef.current) return;
      setDiscovered((current) => {
        const merged = new Map(current.map((server) => [`${server.serverId}|${server.serverUrl}`, server]));
        next.forEach((server) => merged.set(`${server.serverId}|${server.serverUrl}`, server));
        return Array.from(merged.values());
      });
    };

    try {
      // Keep discovery alive for about 15 seconds. Three separate windows let
      // a server appear after the first ~5 s instead of hiding results until
      // the entire search has finished.
      for (let pass = 0; pass < 3; pass += 1) {
        if (runId !== scanRunRef.current) return;
        try {
          mergeDiscovered(await discoverServers(5000));
        } catch {
          // Restricted Wi-Fi may block multicast. Keep searching and expose
          // manual entry separately instead of turning discovery into an error.
        }
        if (pass < 2 && runId === scanRunRef.current) {
          // Give Android NSD a moment to fully stop the previous browser before
          // starting the next discovery window.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        }
      }
    } finally {
      if (runId === scanRunRef.current) setDiscovering(false);
    }
  };

  useEffect(() => {
    if (mode !== "existing") return;
    setDiscovered([]);
    setServerUrl("");
    setPendingTrust(null);
    setManualEntryOpen(false);
    setManualFallbackVisible(false);
    void scanServers();

    const fallbackTimer = window.setTimeout(() => {
      setManualFallbackVisible(true);
    }, 5000);

    return () => {
      window.clearTimeout(fallbackTimer);
      scanRunRef.current += 1;
    };
  }, [mode]);

  const finishConnection = (url: string) => {
    finishAndroidSetup(url);
    setPendingTrust(null);
    onDone();
  };

  const connectExisting = async (target = serverUrl) => {
    setBusy(true);
    resetError();
    setPendingTrust(null);
    try {
      const result = await testServer(target);
      setServerUrl(result.serverUrl);
      if (result.needsTrust) {
        setPendingTrust({
          serverUrl: result.serverUrl,
          serverId: result.serverId,
          pin: result.pin,
          status: result.status,
        });
        return;
      }
      finishConnection(result.serverUrl);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  };

  const confirmServerTrust = async () => {
    if (!pendingTrust) return;
    setBusy(true);
    resetError();
    try {
      await trustServerIdentity(pendingTrust.serverUrl, pendingTrust.serverId, pendingTrust.pin);
      const checked = await testServer(pendingTrust.serverUrl);
      if (checked.needsTrust) throw new Error("Не удалось сохранить ключ сервера");
      finishConnection(checked.serverUrl);
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

      // SSH fingerprint was explicitly verified before installation, so the
      // freshly installed TLS identity can be pinned without a second prompt.
      const probe = await probeServerIdentity(result.serverUrl);
      await trustServerIdentity(probe.serverUrl, probe.serverId, probe.pin);
      const checked = await testServer(probe.serverUrl);
      if (checked.needsTrust) throw new Error("Не удалось закрепить TLS-ключ установленного сервера");

      setPassword("");
      setSudoPassword("");
      finishConnection(checked.serverUrl);
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
          <p className="mt-2 max-w-2xl text-sm leading-6 text-frost/50">Сервер можно найти автоматически в локальной сети или установить на Debian/Ubuntu по SSH.</p>
        </div>

        <div className="p-7 sm:p-9">
          {mode === "choose" && (
            <div className="grid gap-4 md:grid-cols-2">
              <button type="button" onClick={() => setMode("existing")} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-left transition hover:border-accent/35 hover:bg-white/[0.055]">
                <Network size={28} className="text-accent" />
                <div className="mt-5 text-lg font-semibold text-frost">Найти сервер</div>
                <div className="mt-2 text-sm leading-6 text-frost/45">Matrix Smartboard попробует обнаружить сервер через mDNS. IP можно ввести вручную как резервный вариант.</div>
              </button>
              <button type="button" onClick={() => setMode("ssh")} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-left transition hover:border-accent/35 hover:bg-white/[0.055]">
                <ServerCog size={28} className="text-accent" />
                <div className="mt-5 text-lg font-semibold text-frost">Настроить сервер по SSH</div>
                <div className="mt-2 text-sm leading-6 text-frost/45">Приложение установит backend как системную службу и закрепит его TLS-идентичность.</div>
              </button>
            </div>
          )}

          {mode === "existing" && (
            <div className="mx-auto max-w-xl">
              <Back onClick={() => { setPendingTrust(null); setMode("choose"); }} />
              <div className="mt-5 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">Серверы в сети</h2>
                  <div className="mt-1 flex items-center gap-2 text-xs text-frost/45">
                    {discovering && <LoaderCircle size={13} className="animate-spin text-accent" />}
                    <span>
                      {discovering
                        ? discovered.length > 0
                          ? "Поиск продолжается…"
                          : "Ищем Matrix Smartboard в локальной сети…"
                        : discovered.length > 0
                          ? `Найдено: ${discovered.length}`
                          : "Автоматический поиск завершён"}
                    </span>
                  </div>
                </div>
                <Button variant="outline" className="h-9" disabled={discovering || busy} onClick={() => void scanServers()}>
                  <Network size={15} className="mr-2" />
                  Повторить поиск
                </Button>
              </div>

              <div className="mt-5 min-h-[78px] space-y-2">
                {discovered.map((server) => (
                  <button
                    key={`${server.serverId}|${server.serverUrl}`}
                    type="button"
                    disabled={busy}
                    onClick={() => { setServerUrl(server.serverUrl); void connectExisting(server.serverUrl); }}
                    className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-left transition hover:border-accent/30 hover:bg-white/[0.05] disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-frost">{server.name}</span>
                      <span className="mt-1 block truncate text-xs text-frost/45">{server.serverUrl}</span>
                    </span>
                    <span className="ml-4 shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-accent">{server.tls ? "TLS" : "HTTP"}</span>
                  </button>
                ))}

                {discovering && discovered.length === 0 && (
                  <div className="flex h-[78px] items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.018]">
                    <div className="text-center">
                      <LoaderCircle size={20} className="mx-auto animate-spin text-accent/80" />
                      <div className="mt-2 text-xs text-frost/40">Поиск может занять до 15 секунд</div>
                    </div>
                  </div>
                )}

                {!discovering && discovered.length === 0 && (
                  <div className="flex h-[78px] items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.018] px-5 text-center text-xs leading-5 text-frost/40">
                    Серверы в этой сети не найдены
                  </div>
                )}
              </div>

              {manualFallbackVisible && !manualEntryOpen && !pendingTrust && (
                <button
                  type="button"
                  onClick={() => { setManualEntryOpen(true); resetError(); }}
                  className="mt-5 h-11 w-full rounded-xl border border-white/10 bg-white/[0.025] text-sm font-medium text-frost/65 transition hover:border-white/20 hover:bg-white/[0.045] hover:text-frost"
                >
                  Ввести адрес сервера вручную
                </button>
              )}

              {manualEntryOpen && !pendingTrust && (
                <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <label className="block text-xs font-medium text-frost/55">Адрес сервера</label>
                  <Input
                    autoFocus
                    className="mt-2 h-12"
                    placeholder="192.168.1.50"
                    value={serverUrl}
                    onChange={(event) => { setServerUrl(event.target.value); setPendingTrust(null); resetError(); }}
                  />
                  <div className="mt-2 text-[11px] text-frost/35">HTTPS и порт 8443 подставятся автоматически</div>
                  <Button variant="accent" className="mt-4 h-11 w-full" disabled={busy || !serverUrl.trim()} onClick={() => void connectExisting()}>
                    {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />Проверка...</> : "Подключиться"}
                  </Button>
                </div>
              )}

              {pendingTrust && (
                <div className="mt-4 rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-accent" />Подтверждение сервера</div>
                  <div className="mt-2 text-xs leading-5 text-frost/55">Первое подключение. Сверьте отпечаток с сервером перед подтверждением.</div>
                  <div className="mt-3 text-[10px] uppercase tracking-[0.12em] text-frost/35">Server ID</div>
                  <code className="mt-1 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{pendingTrust.serverId}</code>
                  <div className="mt-3 text-[10px] uppercase tracking-[0.12em] text-frost/35">Public key pin</div>
                  <code className="mt-1 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{pendingTrust.pin}</code>
                  <Button variant="accent" className="mt-4 h-11 w-full" disabled={busy} onClick={() => void confirmServerTrust()}>
                    Подтвердить и закрепить сервер
                  </Button>
                </div>
              )}

              {error && <ErrorBox text={error} />}
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
                  <div className="mt-4"><Field label="HTTPS порт Matrix Smartboard"><Input inputMode="numeric" value={backendPort} onChange={(e) => setBackendPort(e.target.value)} /></Field></div>

                  <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4">
                    <input type="checkbox" className="mt-1" checked={installLocalAi} onChange={(e) => setInstallLocalAi(e.target.checked)} />
                    <span><span className="block text-sm font-medium">Установить локальный ИИ</span><span className="mt-1 block text-xs leading-5 text-frost/40">Ollama, Qwen 2.5 7B и Qwen 2.5 VL 3B. Интернет нужен только для установки и загрузки моделей.</span></span>
                  </label>

                  {!fingerprint ? (
                    <Button variant="accent" className="mt-6 h-11 w-full" disabled={busy || !host.trim() || !username.trim() || !password} onClick={() => void inspectSsh()}>
                      {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />Подключение...</> : "Проверить SSH"}
                    </Button>
                  ) : (
                    <div className="mt-6 rounded-xl border border-accent/20 bg-accent/[0.06] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-accent" />SSH host key</div>
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
