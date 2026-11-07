import { apiFetch, getApiBaseUrl, isNativeApp, NativeSecurity } from "@/lib/apiClient";
import { refreshClusterMembers } from "@/lib/cluster";

export type InviteTarget = { serverUrl: string; serverId: string; pin: string };

const detail = async (response: Response) => {
  const data = await response.json().catch(() => ({}));
  return (data as { detail?: string }).detail || `HTTP ${response.status}`;
};

/**
 * Adds a server to this board's cluster without signing in to it. The board stays on its own
 * server: it pins the new server's key (shown to the user before this is called), takes a pairing
 * code from its own server and hands it to the new one, which then pairs with the cluster itself.
 * Only a server with no school of its own, started recently, takes this (`clusterInviteOpen`).
 */
export async function inviteToCluster(target: InviteTarget): Promise<void> {
  const base = target.serverUrl.replace(/\/+$/, "");
  if (isNativeApp() && base.startsWith("https://")) {
    // Trust only: unlike trustServerIdentity this does not move the board to that server.
    await NativeSecurity.trustServer({ serverUrl: base, serverId: target.serverId, pin: target.pin });
  }
  const codeResponse = await apiFetch("/api/cluster/pairing-code", { method: "POST", cache: "no-store" });
  if (!codeResponse.ok) throw new Error(await detail(codeResponse));
  const invite = await codeResponse.json() as { code: string; url?: string; ownerSchool?: string };
  // Servers before this change do not say their cluster address; the board's own address works too.
  const clusterUrl = invite.url || getApiBaseUrl();

  const joined = await fetch(`${base}/api/cluster/join`, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: { "Content-Type": "application/json", "X-Matrix-Mobile": "1" },
    body: JSON.stringify({ url: clusterUrl, code: invite.code, ownerSchool: invite.ownerSchool }),
  });
  if (!joined.ok) throw new Error(await detail(joined));
  await refreshClusterMembers().catch(() => undefined);
}
