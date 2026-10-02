import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArchiveRestore,
  CheckCircle2,
  Cpu,
  DatabaseBackup,
  Download,
  HardDrive,
  MemoryStick,
  RefreshCw,
  RotateCw,
  ServerCog,
  TerminalSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { currentServerUrl } from "@/app/setup/androidSetup";
import {
  serverManagementApi,
  type ModelJobs,
  type ServerLogs,
  type ServerManagementStatus,
} from "./serverManagementApi";

type Props = {
  open: boolean;
  onClose: () => void;
  connectionState?: "online" | "offline" | "syncing";
  pendingOperations?: number;
};

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
};

const shortSha = (sha?: string) => sha ? sha.slice(0, 8) : "—";

const formatUptime = (seconds: number, locale: string) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (locale === "en") return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean).join(" ") || "<1m";
  if (locale === "kk") return [days && `${days}к`, hours && `${hours}с`, minutes && `${minutes}м`].filter(Boolean).join(" ") || "<1м";
  return [days && `${days}д`, hours && `${hours}ч`, minutes && `${minutes}м`].filter(Boolean).join(" ") || "<1м";
};

const installedNames = (status: ServerManagementStatus | null) =>
  new Set((status?.models ?? []).map((model) => model.name));

export default function ServerManagementPanel({
  open,
  onClose,
  connectionState = "online",
  pendingOperations = 0,
}: Props) {
  const { locale, tl } = useI18n();
  const [status, setStatus] = useState<ServerManagementStatus | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [logs, setLogs] = useState<ServerLogs | null>(null);
  const [jobs, setJobs] = useState<ModelJobs>({ jobs: {} });
  const [busyAction, setBusyAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);
  const [logTab, setLogTab] = useState<keyof ServerLogs>("backend");
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = async (forceUpdate = false) => {
    setError("");
    try {
      const result = await serverManagementApi.status();
      let next = result.data;
      if (forceUpdate) {
        const update = await serverManagementApi.updateInfo(true);
        next = { ...next, update };
      }
      setStatus(next);
      setLatency(result.latencyMs);
      return next;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    }
  };

  const refreshLogs = async () => {
    try {
      setLogs(await serverManagementApi.logs());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    void refresh().catch(() => undefined);
    const id = window.setInterval(() => {
      if (!active) return;
      void refresh().catch(() => undefined);
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const hasRunning = Object.values(jobs.jobs).some((job) => job.state === "running");
    if (!hasRunning) return;
    const id = window.setInterval(() => {
      void serverManagementApi.modelJobs().then(setJobs).catch(() => undefined);
      void refresh().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [jobs, open]);

  useEffect(() => {
    if (!open || !updating) return;
    let failures = 0;
    const id = window.setInterval(async () => {
      try {
        const next = await refresh(true);
        failures = 0;
        if (next.update.latestSha && next.update.localSha === next.update.latestSha) {
          setUpdating(false);
          setMessage(tl("server_update_done"));
          void refreshLogs();
        }
      } catch {
        failures += 1;
        if (failures > 40) {
          setUpdating(false);
          setError(tl("server_update_timeout"));
        }
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [open, updating, tl]);

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose, open]);

  const runAction = async (name: string, action: () => Promise<unknown>, success: string) => {
    setBusyAction(name);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      window.setTimeout(() => void refresh().catch(() => undefined), 1800);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction("");
    }
  };

  const downloadBackup = async () => {
    setBusyAction("backup");
    setError("");
    try {
      const blob = await serverManagementApi.createBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `matrix-smartboard-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setMessage(tl("server_backup_done"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction("");
    }
  };

  const restoreBackup = async (file: File) => {
    setBusyAction("restore");
    setError("");
    setMessage("");
    try {
      const result = await serverManagementApi.restoreBackup(file);
      setMessage(
        result.restartRequired
          ? tl("server_restore_done_restart")
          : tl("server_restore_done"),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction("");
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };

  const startUpdate = async () => {
    setBusyAction("update");
    setError("");
    setMessage("");
    try {
      await serverManagementApi.startUpdate();
      setUpdating(true);
      setMessage(tl("server_update_started"));
      void refreshLogs();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction("");
    }
  };

  const pullModel = async (model: string) => {
    await runAction(
      `model:${model}`,
      async () => {
        await serverManagementApi.pullModel(model);
        setJobs(await serverManagementApi.modelJobs());
      },
      tl("server_model_download_started"),
    );
  };

  const connectionLabel =
    connectionState === "offline"
      ? tl("server_connection_offline")
      : connectionState === "syncing"
        ? tl("server_connection_syncing")
        : tl("server_connection_online");

  const models = useMemo(() => installedNames(status), [status]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-2 backdrop-blur-sm sm:p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="glass flex max-h-[92vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[20px] border border-white/10 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ServerCog size={17} className="text-accent" />
              <h2 className="truncate text-base font-semibold">{tl("server_panel_title")}</h2>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-frost/45">
              {status?.serverName || tl("server_loading")} · {currentServerUrl()}
            </div>
          </div>
          <Button variant="ghost" className="h-8 w-8 shrink-0 rounded-lg p-0" onClick={onClose} aria-label={tl("close")}>
            <X size={16} />
          </Button>
        </div>

        <div className="scrollbar-hide overflow-y-auto p-4 sm:p-4">
          <div className="grid gap-2.5 md:grid-cols-4">
            <StatCard
              icon={<Activity size={16} />}
              label={tl("server_connection")}
              value={connectionLabel}
              detail={pendingOperations > 0 ? tl("server_pending_ops", { count: pendingOperations }) : `${latency ?? "—"} ms`}
              good={connectionState === "online"}
            />
            <StatCard
              icon={<Cpu size={16} />}
              label="CPU"
              value={status ? `${Math.round(status.cpu.percent)}%` : "—"}
              detail={status ? tl("server_cpu_cores", { count: status.cpu.logicalCores }) : ""}
            />
            <StatCard
              icon={<MemoryStick size={16} />}
              label="RAM"
              value={status ? `${Math.round(status.memory.percent)}%` : "—"}
              detail={status ? `${formatBytes(status.memory.used)} / ${formatBytes(status.memory.total)}` : ""}
            />
            <StatCard
              icon={<HardDrive size={16} />}
              label={tl("server_disk")}
              value={status ? `${Math.round(status.disk.percent)}%` : "—"}
              detail={status ? tl("server_disk_free", { value: formatBytes(status.disk.free) }) : ""}
            />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[1.08fr_.92fr]">
            <section className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{tl("server_info")}</div>
                  <div className="mt-1 text-[11px] text-frost/40">
                    {status ? `${status.platform} ${status.platformRelease} · ${status.hostname}` : tl("server_loading")}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9"
                  disabled={busyAction === "refresh"}
                  onClick={() => void runAction("refresh", () => refresh(true), tl("server_refreshed"))}
                >
                  <RefreshCw size={14} className={busyAction === "refresh" ? "mr-2 animate-spin" : "mr-2"} />
                  {tl("server_refresh")}
                </Button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 text-[11px] sm:grid-cols-3">
                <Info label={tl("server_platform")} value={status?.platform || "—"} />
                <Info label={tl("server_uptime")} value={status ? formatUptime(status.uptimeSeconds, locale) : "—"} />
                <Info label="Python" value={status?.python || "—"} />
                <Info label={tl("server_current_commit")} value={shortSha(status?.update.localSha)} mono />
                <Info label={tl("server_latest_commit")} value={shortSha(status?.update.latestSha)} mono />
                <Info label="GPU" value={status?.gpu?.name || "—"} />
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <ServiceRow
                  label="Matrix backend"
                  online={!!status?.services.backend}
                  actionLabel={tl("server_restart")}
                  busy={busyAction === "restart-backend"}
                  disabled={!status?.capabilities.restartBackend}
                  onAction={() => void runAction(
                    "restart-backend",
                    () => serverManagementApi.restart("backend"),
                    tl("server_backend_restarting"),
                  )}
                />
                <ServiceRow
                  label="Ollama"
                  online={!!status?.services.ollama}
                  actionLabel={tl("server_restart")}
                  busy={busyAction === "restart-ollama"}
                  disabled={!status?.capabilities.restartOllama}
                  onAction={() => void runAction(
                    "restart-ollama",
                    () => serverManagementApi.restart("ollama"),
                    tl("server_ollama_restarting"),
                  )}
                />
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <div className="text-sm font-semibold">{tl("server_update")}</div>
              <div className="mt-2 text-xs leading-5 text-frost/45">
                {status?.update.updateAvailable
                  ? tl("server_update_available")
                  : status?.update.latestSha
                    ? tl("server_up_to_date")
                    : tl("server_update_unknown")}
              </div>
              <div className="mt-2.5 rounded-lg border border-white/[0.07] bg-black/10 px-2.5 py-2 text-[10px] leading-4 text-frost/45">
                {tl("server_rollback_note")}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-9 text-xs"
                  disabled={busyAction === "refresh-update"}
                  onClick={() => void runAction(
                    "refresh-update",
                    () => refresh(true),
                    tl("server_refreshed"),
                  )}
                >
                  {tl("server_check_updates")}
                </Button>
                <Button
                  variant="accent"
                  className="h-9 text-xs"
                  disabled={!status?.update.canUpdate || updating || busyAction === "update" || !status?.update.updateAvailable}
                  onClick={() => void startUpdate()}
                >
                  {updating ? <RefreshCw size={14} className="mr-2 animate-spin" /> : <Download size={14} className="mr-2" />}
                  {updating ? tl("server_updating") : tl("server_install_update")}
                </Button>
              </div>
              {status && !status.update.canUpdate && (
                <div className="mt-2 text-[10px] leading-4 text-frost/35">{tl("server_update_agent_missing")}</div>
              )}
            </section>
          </div>

          <section className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{tl("server_models")}</div>
                <div className="mt-1 text-[11px] text-frost/40">{tl("server_models_description")}</div>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(status?.expectedModels ?? ["qwen2.5:7b", "qwen2.5vl:3b"]).map((model) => {
                const installed = models.has(model);
                const job = jobs.jobs[model];
                const pulling = job?.state === "running";
                return (
                  <div key={model} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-black/10 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-frost/75">{model}</div>
                      <div className="mt-1 text-[10px] text-frost/35">
                        {pulling
                          ? tl("server_model_downloading")
                          : installed
                            ? tl("server_model_installed")
                            : job?.state === "error"
                              ? tl("server_model_error")
                              : tl("server_model_missing")}
                      </div>
                    </div>
                    {installed ? (
                      <CheckCircle2 size={17} className="shrink-0 text-emerald-500" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={!status?.services.ollama || pulling || busyAction === `model:${model}`}
                        onClick={() => void pullModel(model)}
                      >
                        {pulling ? <RefreshCw size={13} className="animate-spin" /> : tl("server_download")}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] p-3">
            <div className="text-sm font-semibold">{tl("server_backup_restore")}</div>
            <div className="mt-1 text-[11px] leading-5 text-frost/40">{tl("server_backup_description")}</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                className="h-9 text-xs"
                disabled={busyAction === "backup"}
                onClick={() => void downloadBackup()}
              >
                <DatabaseBackup size={15} className="mr-2" />
                {busyAction === "backup" ? tl("server_backup_creating") : tl("server_create_backup")}
              </Button>
              <Button
                variant="outline"
                className="h-9 text-xs"
                disabled={busyAction === "restore"}
                onClick={() => restoreInputRef.current?.click()}
              >
                <ArchiveRestore size={15} className="mr-2" />
                {busyAction === "restore" ? tl("server_restoring") : tl("server_restore_backup")}
              </Button>
              <input
                ref={restoreInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void restoreBackup(file);
                }}
              />
            </div>
          </section>

          <section className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] p-3">
            <details
              onToggle={(event) => {
                if ((event.currentTarget as HTMLDetailsElement).open) void refreshLogs();
              }}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
                <TerminalSquare size={16} />
                {tl("server_detailed_logs")}
              </summary>
              <div className="mt-3">
                <div className="flex flex-wrap gap-1.5">
                  {(["backend", "ollama", "update"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setLogTab(tab)}
                      className={`rounded-lg px-3 py-1.5 text-[10px] font-semibold transition ${
                        logTab === tab ? "bg-accent text-accentText" : "bg-white/[0.045] text-frost/50 hover:text-frost"
                      }`}
                    >
                      {tab === "backend" ? "Backend" : tab === "ollama" ? "Ollama" : tl("server_update")}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void refreshLogs()}
                    className="ml-auto rounded-lg px-3 py-1.5 text-[10px] font-semibold text-frost/45 hover:bg-white/[0.045] hover:text-frost"
                  >
                    {tl("server_refresh")}
                  </button>
                </div>
                <pre className="scrollbar-hide mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-black/20 p-3 font-mono text-[10px] leading-5 text-frost/55">
                  {logs?.[logTab]?.trim() || tl("server_no_logs")}
                </pre>
              </div>
            </details>
          </section>

          {(message || error) && (
            <div className={`mt-4 rounded-xl border px-3 py-2 text-xs ${
              error
                ? "border-red-500/25 bg-red-500/10 text-red-200"
                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-100"
            }`}>
              {error || message}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
  good,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  good?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-frost/35">
        <span className={good ? "text-emerald-500" : "text-frost/45"}>{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 text-base font-semibold text-frost">{value}</div>
      {detail && <div className="mt-1 truncate text-[10px] text-frost/35">{detail}</div>}
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-frost/35">{label}</div>
      <div className={`mt-1 truncate text-xs text-frost/70 ${mono ? "font-mono" : ""}`} title={value}>{value}</div>
    </div>
  );
}

function ServiceRow({
  label,
  online,
  actionLabel,
  busy,
  disabled = false,
  onAction,
}: {
  label: string;
  online: boolean;
  actionLabel: string;
  busy: boolean;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-frost/70">{label}</div>
        <div className={`mt-1 text-[10px] ${online ? "text-emerald-500" : "text-red-300"}`}>
          {online ? "● online" : "● offline"}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="h-8 shrink-0" disabled={busy || disabled} onClick={onAction}>
        <RotateCw size={13} className={busy ? "mr-1.5 animate-spin" : "mr-1.5"} />
        {actionLabel}
      </Button>
    </div>
  );
}
