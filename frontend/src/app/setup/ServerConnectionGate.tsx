import { CircleCheck, CircleX, LoaderCircle, Minus, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import type { ConnectionCheckState, SavedServerConnectionResult } from "./androidSetup";

type Props = {
  checking: boolean;
  serverName?: string;
  result?: SavedServerConnectionResult | null;
  onRetry: () => void;
  onConfigure: () => void;
};

const checkIcon = (state: ConnectionCheckState) => {
  if (state === "ok") return <CircleCheck size={16} className="text-accent" />;
  if (state === "failed") return <CircleX size={16} className="text-danger" />;
  return <Minus size={16} className="text-frost/25" />;
};

export default function ServerConnectionGate({ checking, serverName, result, onRetry, onConfigure }: Props) {
  const { tl } = useI18n();

  const reasonText = result ? ({
    "server-not-found": tl("server_reason_not_found"),
    "server-found-unreachable": tl("server_reason_found_unreachable"),
    "identity-changed": tl("server_reason_identity_changed"),
    "incompatible": tl("server_reason_incompatible"),
    "discovery-unavailable": tl("server_reason_discovery_unavailable"),
    "not-configured": tl("server_reason_not_configured"),
    "connected": "",
  }[result.reason] ?? tl("server_offline_description")) : "";

  return (
    <main className="session-shell grid-overlay flex items-center justify-center p-5 sm:p-7">
      <section className="glass w-full max-w-[560px] rounded-[24px] border border-white/10 p-6 shadow-soft sm:p-8">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-accent">Matrix Smartboard</div>

        {checking ? (
          <div className="py-8 text-center">
            <LoaderCircle size={28} className="mx-auto animate-spin text-accent" />
            <h1 className="mt-5 text-2xl font-bold tracking-[-0.03em] text-frost">{tl("server_connecting_title")}</h1>
            {serverName && <div className="mt-2 text-sm font-medium text-frost/70">{serverName}</div>}
            <p className="mt-2 text-sm text-frost/40">{tl("server_connecting_description")}</p>
          </div>
        ) : (
          <>
            <div className="mt-5">
              <h1 className="text-2xl font-bold tracking-[-0.03em] text-frost">{tl("server_offline_title")}</h1>
              {(result?.serverName || serverName) && (
                <div className="mt-2 text-sm font-semibold text-frost/70">{result?.serverName || serverName}</div>
              )}
              <p className="mt-2 text-sm leading-6 text-frost/45">{reasonText || tl("server_offline_description")}</p>
            </div>

            {result && (
              <div className="mt-6 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02]">
                <CheckRow label={tl("server_check_saved_address")} state={result.checks.savedAddress} />
                <CheckRow label={tl("server_check_discovery")} state={result.checks.discovery} />
                <CheckRow label={tl("server_check_identity")} state={result.checks.identity} />
                <CheckRow label={tl("server_check_backend")} state={result.checks.backend} last />
              </div>
            )}

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <Button variant="accent" className="h-11 w-full" onClick={onRetry}>
                <Network size={16} className="mr-2" />
                {tl("server_retry")}
              </Button>
              <Button variant="outline" className="h-11 w-full" onClick={onConfigure}>
                {tl("server_reconfigure")}
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function CheckRow({ label, state, last = false }: { label: string; state: ConnectionCheckState; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 ${last ? "" : "border-b border-white/[0.06]"}`}>
      <span className="text-sm text-frost/55">{label}</span>
      <span className="shrink-0">{checkIcon(state)}</span>
    </div>
  );
}
