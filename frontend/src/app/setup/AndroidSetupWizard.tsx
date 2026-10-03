import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, LoaderCircle, Network, ServerCog, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n, type LocaleCode } from "@/i18n";
import { AnimatePresence, motion } from "framer-motion";
import {
  discoverServers,
  finishAndroidSetup,
  probeServerIdentity,
  SshProvisioner,
  testServer,
  trustServerIdentity,
  type DiscoveredServer,
  type RemoteSshPlatform,
  type ServerStatus,
} from "./androidSetup";

type Mode = "language" | "choose" | "existing" | "ssh";
type Props = { onDone: () => void; skipLanguage?: boolean };
type PendingTrust = {
  serverUrl: string;
  serverId: string;
  pin: string;
  status: ServerStatus;
};

const SETUP_LANGUAGES: Array<{ code: LocaleCode; label: string; badge: string }> = [
  { code: "ru", label: "Русский", badge: "RU" },
  { code: "kk", label: "Қазақша", badge: "KZ" },
  { code: "en", label: "English", badge: "EN" },
];

const LANGUAGE_PROMPTS = ["Выберите язык", "Тілді таңдаңыз", "Choose language"] as const;

export default function AndroidSetupWizard({ onDone, skipLanguage = false }: Props) {
  const { setLocale, tl } = useI18n();
  const [mode, setMode] = useState<Mode>(() => skipLanguage ? "choose" : "language");
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
  const [serverName, setServerName] = useState("");
  const [installLocalAi, setInstallLocalAi] = useState(true);
  const [fingerprint, setFingerprint] = useState("");
  const [remotePlatform, setRemotePlatform] = useState<RemoteSshPlatform | null>(null);
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [languagePromptIndex, setLanguagePromptIndex] = useState(0);
  const scanRunRef = useRef(0);

  const resetError = () => setError(null);

  const localizedError = (next: unknown) => {
    const raw = next instanceof Error ? next.message : String(next);
    if (/SSH: соединение отклонено|ECONNREFUSED|Connection refused|failed to connect/i.test(raw)) return tl("setup_error_ssh_refused");
    if (/Failed to fetch|NetworkError|Load failed|сервер не отвечает/i.test(raw)) return tl("setup_error_connection");
    if (/неверный пользователь или пароль|Auth fail/i.test(raw)) return tl("setup_error_ssh_auth");
    if (/fingerprint изменился/i.test(raw)) return tl("setup_error_ssh_fingerprint_changed");
    if (/Это не Matrix Smartboard server/i.test(raw)) return tl("setup_error_not_matrix_server");
    if (/Версия сервера устарела/i.test(raw)) return tl("setup_error_server_outdated");
    if (/Этот APK устарел/i.test(raw)) return tl("setup_error_app_outdated");
    if (/TLS identity сервера не совпадает/i.test(raw)) return tl("setup_error_tls_identity");
    if (/Android-клиент принимает только защищённые|Ожидается https|TLS probe требует https/i.test(raw)) return tl("setup_error_https_required");
    if (/Некорректный адрес/i.test(raw)) return tl("setup_error_invalid_address");
    return raw;
  };

  const chooseLanguage = (nextLocale: LocaleCode) => {
    setLocale(nextLocale);
    setMode("choose");
    resetError();
  };

  useEffect(() => {
    if (mode !== "language") return;
    const timer = window.setInterval(() => {
      setLanguagePromptIndex((current) => (current + 1) % LANGUAGE_PROMPTS.length);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [mode]);

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
      setError(localizedError(next));
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
      if (checked.needsTrust) throw new Error(tl("setup_error_save_server_key"));
      finishConnection(checked.serverUrl);
    } catch (next) {
      setError(localizedError(next));
    } finally {
      setBusy(false);
    }
  };

  const inspectSsh = async () => {
    setBusy(true); resetError(); setFingerprint(""); setRemotePlatform(null); setFingerprintConfirmed(false);
    try {
      const result = await SshProvisioner.inspectHost({
        host: host.trim(),
        port: Number(sshPort),
        username: username.trim(),
        password,
      });
      setFingerprint(result.fingerprint);
      setRemotePlatform(result.platform);
    } catch (next) {
      setError(localizedError(next));
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
        serverName: serverName.trim(),
        installLocalAi,
      });

      // SSH fingerprint was explicitly verified before installation, so the
      // freshly installed TLS identity can be pinned without a second prompt.
      const probe = await probeServerIdentity(result.serverUrl);
      await trustServerIdentity(probe.serverUrl, probe.serverId, probe.pin);
      const checked = await testServer(probe.serverUrl);
      if (checked.needsTrust) throw new Error(tl("setup_error_pin_installed_server"));

      setPassword("");
      setSudoPassword("");
      finishConnection(checked.serverUrl);
    } catch (next) {
      setError(localizedError(next));
    } finally {
      await handle?.remove();
      setBusy(false);
    }
  };

  return (
    <main className="android-setup-shell session-shell grid-overlay">
      <section className="android-setup-panel glass overflow-hidden rounded-[24px] border border-white/10 shadow-soft">
        <div className="android-setup-header border-b border-white/10 px-7 py-6 sm:px-9">
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-accent">Matrix Smartboard</div>
          {mode === "language" ? (
            <h1 className="mt-2 min-h-[2.6rem] overflow-hidden text-3xl font-bold tracking-[-0.03em] text-frost">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={LANGUAGE_PROMPTS[languagePromptIndex]}
                  className="block"
                  initial={{ opacity: 0, y: 7 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -7 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  {LANGUAGE_PROMPTS[languagePromptIndex]}
                </motion.span>
              </AnimatePresence>
            </h1>
          ) : (
            <>
              <h1 className="mt-2 text-3xl font-bold tracking-[-0.03em] text-frost">{tl("setup_title")}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-frost/50">{tl("setup_description")}</p>
            </>
          )}
        </div>

        <div className="android-setup-body p-7 sm:p-9">
          {mode === "language" && (
            <div className="android-setup-language mx-auto w-full">
              <div className="android-setup-language-grid grid gap-3">
                {SETUP_LANGUAGES.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => chooseLanguage(item.code)}
                    className="group flex min-h-[74px] w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-left transition hover:border-accent/35 hover:bg-white/[0.055]"
                  >
                    <span className="text-lg font-semibold text-frost">{item.label}</span>
                    <span className="rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] text-frost/35 transition group-hover:border-accent/25 group-hover:text-accent">{item.badge}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {mode === "choose" && (
            <div className="android-setup-choice grid gap-4 md:grid-cols-2">
              <button type="button" onClick={() => setMode("existing")} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-left transition hover:border-accent/35 hover:bg-white/[0.055]">
                <Network size={28} className="text-accent" />
                <div className="mt-5 text-lg font-semibold text-frost">{tl("setup_find_server")}</div>
                <div className="mt-2 text-sm leading-6 text-frost/45">{tl("setup_find_server_description")}</div>
              </button>
              <button type="button" onClick={() => setMode("ssh")} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-left transition hover:border-accent/35 hover:bg-white/[0.055]">
                <ServerCog size={28} className="text-accent" />
                <div className="mt-5 text-lg font-semibold text-frost">{tl("setup_ssh_setup")}</div>
                <div className="mt-2 text-sm leading-6 text-frost/45">{tl("setup_ssh_setup_description")}</div>
              </button>
            </div>
          )}

          {mode === "existing" && (
            <div className="android-setup-existing mx-auto w-full">
              <Back label={tl("back")} onClick={() => { setPendingTrust(null); setMode("choose"); }} />
              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-xl font-semibold">{tl("setup_servers_in_network")}</h2>
                <Button
                  variant="outline"
                  className="h-10 w-full shrink-0 sm:w-auto"
                  disabled={discovering || busy}
                  onClick={() => void scanServers()}
                >
                  <Network size={15} className="mr-2" />
                  {tl("setup_search_again")}
                </Button>
              </div>

              <div className="mt-5 min-h-[78px] space-y-2">
                {discovered.map((server) => {
                  const selected = pendingTrust?.serverUrl === server.serverUrl;
                  return (
                    <div
                      key={`${server.serverId}|${server.serverUrl}`}
                      className={selected ? "overflow-hidden rounded-xl border border-accent/30 bg-accent/[0.055]" : ""}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { setServerUrl(server.serverUrl); void connectExisting(server.serverUrl); }}
                        className={`flex w-full items-center justify-between border px-4 py-3 text-left transition disabled:opacity-60 ${
                          selected
                            ? "border-transparent bg-transparent"
                            : "rounded-xl border-white/10 bg-white/[0.025] hover:border-accent/30 hover:bg-white/[0.05]"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-frost">{server.name}</span>
                          <span className="mt-1 block truncate text-xs text-frost/45">{server.serverUrl}</span>
                        </span>
                        <span className="ml-4 shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-accent">{server.tls ? "TLS" : "HTTP"}</span>
                      </button>
                      {selected && pendingTrust && (
                        <div className="border-t border-accent/15 px-4 pb-4 pt-3">
                          <div className="flex items-center gap-2 text-sm font-semibold">
                            <ShieldCheck size={17} className="text-accent" />
                            {tl("setup_server_confirmation")}
                          </div>
                          <div className="mt-1.5 text-xs leading-5 text-frost/55">{tl("setup_verify_fingerprint")}</div>
                          <div className="mt-3 grid gap-2 lg:grid-cols-2">
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.12em] text-frost/35">Server ID</div>
                              <code className="mt-1 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{pendingTrust.serverId}</code>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.12em] text-frost/35">Public key pin</div>
                              <code className="mt-1 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{pendingTrust.pin}</code>
                            </div>
                          </div>
                          <Button variant="accent" className="mt-3 h-10 w-full" disabled={busy} onClick={() => void confirmServerTrust()}>
                            {tl("setup_confirm_pin_server")}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {discovering && discovered.length === 0 && (
                  <div className="flex h-[78px] items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.018]">
                    <div className="text-center">
                      <LoaderCircle size={20} className="mx-auto animate-spin text-accent/80" />
                      <div className="mt-2 text-xs text-frost/40">{tl("setup_search_up_to_15_seconds")}</div>
                    </div>
                  </div>
                )}

                {!discovering && discovered.length === 0 && (
                  <div className="flex h-[78px] items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.018] px-5 text-center text-xs leading-5 text-frost/40">
                    {tl("setup_servers_not_found")}
                  </div>
                )}
              </div>

              {manualFallbackVisible && !manualEntryOpen && !pendingTrust && (
                <button
                  type="button"
                  onClick={() => { setManualEntryOpen(true); resetError(); }}
                  className="mt-5 h-11 w-full rounded-xl border border-white/10 bg-white/[0.025] text-sm font-medium text-frost/65 transition hover:border-white/20 hover:bg-white/[0.045] hover:text-frost"
                >
                  {tl("setup_enter_server_manually")}
                </button>
              )}

              {manualEntryOpen && !pendingTrust && (
                <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
                  <label className="block text-xs font-medium text-frost/55">{tl("setup_server_address")}</label>
                  <Input
                    autoFocus
                    className="mt-2 h-12"
                    placeholder="192.168.1.50"
                    value={serverUrl}
                    onChange={(event) => { setServerUrl(event.target.value); setPendingTrust(null); resetError(); }}
                  />
                  <div className="mt-2 text-[11px] text-frost/35">{tl("setup_https_port_auto")}</div>
                  <Button variant="accent" className="mt-4 h-11 w-full" disabled={busy || !serverUrl.trim()} onClick={() => void connectExisting()}>
                    {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />{tl("setup_checking")}</> : tl("setup_connect")}
                  </Button>
                </div>
              )}

              {pendingTrust && !discovered.some((server) => server.serverUrl === pendingTrust.serverUrl) && (
                <div className="mt-4 rounded-xl border border-accent/25 bg-accent/[0.06] p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-accent" />{tl("setup_server_confirmation")}</div>
                  <div className="mt-2 text-xs leading-5 text-frost/55">{tl("setup_verify_fingerprint")}</div>
                  <div className="mt-3 text-[10px] uppercase tracking-[0.12em] text-frost/35">Server ID</div>
                  <code className="mt-1 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{pendingTrust.serverId}</code>
                  <div className="mt-3 text-[10px] uppercase tracking-[0.12em] text-frost/35">Public key pin</div>
                  <code className="mt-1 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{pendingTrust.pin}</code>
                  <Button variant="accent" className="mt-4 h-11 w-full" disabled={busy} onClick={() => void confirmServerTrust()}>
                    {tl("setup_confirm_pin_server")}
                  </Button>
                </div>
              )}

              {error && <ErrorBox text={error} />}
            </div>
          )}

          {mode === "ssh" && (
            <div>
              <Back label={tl("back")} onClick={() => setMode("choose")} />
              <div className="mt-5 grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
                <div>
                  <h2 className="text-xl font-semibold">{tl("setup_ssh_server")}</h2>
                  <div className="mt-5">
                    <Field label={tl("setup_server_name")}>
                      <Input
                        value={serverName}
                        maxLength={48}
                        placeholder={tl("setup_server_name_placeholder")}
                        onChange={(e) => setServerName(e.target.value)}
                      />
                    </Field>
                    <div className="mt-2 text-[11px] text-frost/35">{tl("setup_server_name_hint")}</div>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_120px]">
                    <Field label={tl("setup_ip_or_domain")}><Input placeholder="192.168.1.10" value={host} onChange={(e) => { setHost(e.target.value); setFingerprint(""); setRemotePlatform(null); resetError(); }} /></Field>
                    <Field label={tl("setup_ssh_port")}><Input inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value)} /></Field>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label={tl("setup_username")}><Input value={username} onChange={(e) => { setUsername(e.target.value); setFingerprint(""); setRemotePlatform(null); }} /></Field>
                    <Field label={tl("setup_ssh_password")}><Input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setFingerprint(""); setRemotePlatform(null); }} /></Field>
                  </div>
                  {remotePlatform === "unix" && username !== "root" && <div className="mt-4"><Field label={tl("setup_sudo_password")}><Input type="password" value={sudoPassword} onChange={(e) => setSudoPassword(e.target.value)} placeholder={tl("setup_sudo_password_hint")} /></Field></div>}
                  <div className="mt-4"><Field label={tl("setup_https_port")}><Input inputMode="numeric" value={backendPort} onChange={(e) => setBackendPort(e.target.value)} /></Field></div>

                  <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4">
                    <input type="checkbox" className="mt-1" checked={installLocalAi} onChange={(e) => setInstallLocalAi(e.target.checked)} />
                    <span><span className="block text-sm font-medium">{tl("setup_install_local_ai")}</span><span className="mt-1 block text-xs leading-5 text-frost/40">{tl("setup_install_local_ai_description")}</span></span>
                  </label>

                  {!fingerprint ? (
                    <Button variant="accent" className="mt-6 h-11 w-full" disabled={busy || !host.trim() || !username.trim() || !password} onClick={() => void inspectSsh()}>
                      {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />{tl("setup_connecting")}</> : tl("setup_check_ssh")}
                    </Button>
                  ) : (
                    <div className="mt-6 rounded-xl border border-accent/20 bg-accent/[0.06] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-accent" />{tl("setup_ssh_host_key")}</div>
                        {remotePlatform && (
                          <span className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-frost/45">
                            {remotePlatform === "windows" ? "Windows" : "macOS / Linux"}
                          </span>
                        )}
                      </div>
                      <code className="mt-3 block break-all rounded-lg bg-black/20 px-3 py-2 text-[11px] text-frost/70">{fingerprint}</code>
                      {remotePlatform === "windows" && (
                        <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px] leading-5 text-frost/45">
                          {tl("setup_windows_admin_hint")}
                        </div>
                      )}
                      <label className="mt-3 flex items-center gap-2 text-xs text-frost/60"><input type="checkbox" checked={fingerprintConfirmed} onChange={(e) => setFingerprintConfirmed(e.target.checked)} />{tl("setup_confirm_ssh_server")}</label>
                      <Button variant="accent" className="mt-4 h-11 w-full" disabled={busy || !fingerprintConfirmed} onClick={() => void provision()}>
                        {busy ? <><LoaderCircle size={16} className="mr-2 animate-spin" />{tl("setup_installing")}</> : tl("setup_install_matrix_smartboard")}
                      </Button>
                    </div>
                  )}
                  {error && <ErrorBox text={error} />}
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold text-frost/60"><Terminal size={15} />{tl("setup_install_progress")}</div>
                  <div className="mt-3 h-[390px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/20 p-3 font-mono text-[10px] leading-5 text-frost/55">
                    {lines.length ? lines.join("\n") : tl("setup_install_log_placeholder")}
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

function Back({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-frost/45 hover:text-frost"><ChevronLeft size={15} />{label}</button>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-medium text-frost/55">{label}</span>{children}</label>;
}
function ErrorBox({ text }: { text: string }) {
  return <div className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-xs text-danger">{text}</div>;
}
