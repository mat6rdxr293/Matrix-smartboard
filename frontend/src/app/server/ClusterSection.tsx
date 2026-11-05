import { useEffect, useState } from "react";
import { Link2, LogOut, Network, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { apiFetch } from "@/lib/apiClient";
import { refreshClusterMembers } from "@/lib/cluster";
import { cn } from "@/lib/utils";

type Member = {
  nodeId: string;
  name: string;
  url: string;
  self: boolean;
  online: boolean;
  load?: { score?: number } | null;
  lastError?: string | null;
};
type ClusterState = { enabled: boolean; clusterId: string | null; nodeId: string; members: Member[]; conflict?: string | null };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, { cache: "no-store", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { detail?: string }).detail || `HTTP ${response.status}`);
  return data as T;
}

/** Cluster of school servers on the "Server" screen: members, adding a server, joining, leaving. */
export default function ClusterSection() {
  const { tl } = useI18n();
  const [state, setState] = useState<ClusterState | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinUrl, setJoinUrl] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const load = () => call<ClusterState>("/api/cluster").then(setState).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      // The board learns the members (and trusts their keys) as soon as the cluster changes.
      await refreshClusterMembers().catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] p-3" data-testid="cluster-section">
      <div className="flex items-center gap-2 text-sm font-semibold"><Network size={15} className="text-accent" />{tl("cluster_title")}</div>
      <div className="mt-1 text-[11px] leading-5 text-frost/40">{tl("cluster_description")}</div>

      {state?.conflict && (
        // Another machine writes under this server's id; syncing stopped so the logs do not mix.
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger/[0.08] px-3 py-2 text-[11px] leading-5 text-danger">{state.conflict}</div>
      )}

      {state?.enabled && (
        <div className="mt-3 space-y-1.5">
          {state.members.map((member) => {
            const score = typeof member.load?.score === "number" ? Math.round(member.load.score * 100) : null;
            return (
              <div key={member.nodeId} className="flex items-center gap-3 rounded-lg border border-white/[0.07] bg-black/10 px-3 py-2">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", member.online ? "bg-accent" : "bg-danger")} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold">
                    {member.name}{member.self && <span className="ml-2 text-[10px] font-medium text-accent">{tl("cluster_this_server")}</span>}
                  </div>
                  <div className="truncate text-[10px] text-frost/40">{member.url}{!member.online && member.lastError ? ` · ${member.lastError}` : ""}</div>
                </div>
                <div className="shrink-0 text-right text-[10px] text-frost/50">
                  {member.online ? (score === null ? "—" : `${tl("cluster_load")} ${score}%`) : tl("cluster_offline")}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {code && (
        <div className="mt-3 rounded-lg border border-accent/25 bg-accent/[0.06] p-3 text-center">
          <div className="font-mono text-2xl font-bold tracking-[0.3em] text-frost">{code}</div>
          <div className="mt-1 text-[11px] text-frost/50">{tl("cluster_code_hint")}</div>
        </div>
      )}

      {joining && !state?.enabled && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_160px_auto]">
          <Input placeholder="https://192.168.1.10:8443" value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} aria-label={tl("cluster_join_url")} />
          <Input placeholder="12345678" inputMode="numeric" maxLength={8} value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ""))} aria-label={tl("cluster_join_code")} />
          <Button variant="accent" className="h-10 text-xs" disabled={busy || joinCode.length !== 8 || !joinUrl.trim()}
            onClick={() => void run(async () => {
              const url = /^https?:\/\//.test(joinUrl.trim()) ? joinUrl.trim() : `https://${joinUrl.trim()}${/:\d+$/.test(joinUrl.trim()) ? "" : ":8443"}`;
              await call("/api/cluster/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, code: joinCode }) });
              setJoining(false);
            })}>
            {tl("cluster_join")}
          </Button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!state?.enabled ? (
          <>
            <Button variant="outline" className="h-9 text-xs" disabled={busy || !state}
              onClick={() => void run(() => call("/api/cluster/create", { method: "POST" }))}>
              <Plus size={15} className="mr-2" />{tl("cluster_create")}
            </Button>
            <Button variant="outline" className="h-9 text-xs" disabled={busy || !state} onClick={() => setJoining((v) => !v)}>
              <Link2 size={15} className="mr-2" />{tl("cluster_join_existing")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" className="h-9 text-xs" disabled={busy}
              onClick={() => void run(async () => setCode((await call<{ code: string }>("/api/cluster/pairing-code", { method: "POST" })).code))}>
              <Plus size={15} className="mr-2" />{tl("cluster_add_server")}
            </Button>
            <Button variant="outline" className="h-9 text-xs" disabled={busy}
              onClick={() => {
                if (!confirmLeave) {
                  setConfirmLeave(true);
                  window.setTimeout(() => setConfirmLeave(false), 4000);
                  return;
                }
                setConfirmLeave(false);
                setCode(null);
                void run(() => call("/api/cluster/leave", { method: "POST" }));
              }}>
              <LogOut size={15} className="mr-2" />{confirmLeave ? tl("cluster_leave_confirm") : tl("cluster_leave")}
            </Button>
          </>
        )}
      </div>
      {error && <div className="mt-2 text-[11px] text-danger">{error}</div>}
    </section>
  );
}
