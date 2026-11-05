import { apiFetch, getApiBaseUrl, isNativeApp, NativeSecurity, normalizeServerBase, setApiBaseUrl, setServerRecoveryHook } from "@/lib/apiClient";

/**
 * Servers of one school working as a cluster (docs/cluster-design.md). The board learns the
 * members from the server it already trusts, trusts their keys the same way, and moves to the
 * least loaded member, or to a live one when its own stops answering. The sign-in travels with
 * it because sessions replicate across the cluster.
 */
export type ClusterMember = {
  nodeId: string;
  name: string;
  url: string;
  pin: string;
  online?: boolean;
  load?: { score?: number } | null;
};

const MEMBERS_KEY = "matrix.cluster.members";
const SERVER_ID_KEY = "matrix.serverId";
const SERVER_NAME_KEY = "matrix.serverName";
/** Move away when the current server is this busy... */
export const BUSY_SCORE = 0.8;
/** ...and only to a server at most this busy. */
export const FREE_SCORE = 0.5;
const CHECK_EVERY_MS = 20_000;
const REFRESH_MEMBERS_EVERY_MS = 60_000;
const STATUS_TIMEOUT_MS = 3_000;

const read = (key: string) => {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const write = (key: string, value: string) => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the board then stays on its server.
  }
};

/** A node id is the start of the hash in its key pin, so a member list cannot pair a key with another id. */
export const nodeIdMatchesPin = (nodeId: string, pin: string) =>
  /^sha256\/[0-9a-f]{64}$/.test(pin) && pin.slice("sha256/".length, "sha256/".length + 24) === nodeId;

export function clusterMembers(): ClusterMember[] {
  try {
    const parsed = JSON.parse(read(MEMBERS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.url === "string" && typeof m.nodeId === "string") : [];
  } catch {
    return [];
  }
}

/** True when ``serverId`` belongs to the cluster of the server this board was set up with. */
export const isClusterMember = (serverId: string | null | undefined) =>
  !!serverId && clusterMembers().some((member) => member.nodeId === serverId);

export async function refreshClusterMembers(): Promise<ClusterMember[]> {
  const response = await apiFetch("/api/cluster/members", { cache: "no-store" });
  if (!response.ok) return clusterMembers();
  const data = await response.json() as { enabled?: boolean; members?: ClusterMember[] };
  if (!data.enabled) {
    write(MEMBERS_KEY, "");
    return [];
  }
  const members = (data.members ?? [])
    .map((member) => ({ ...member, url: normalizeServerBase(member.url) }))
    .filter((member) => member.url.startsWith("https://") && nodeIdMatchesPin(member.nodeId, member.pin));
  if (isNativeApp()) {
    // The list came over the connection to a server the board already trusts, so its members'
    // keys are trusted the same way.
    for (const member of members) {
      try {
        await NativeSecurity.trustServer({ serverUrl: member.url, serverId: member.nodeId, pin: member.pin });
      } catch {
        // A member the board cannot pin is simply not used.
      }
    }
  }
  write(MEMBERS_KEY, JSON.stringify(members.map(({ nodeId, name, url, pin }) => ({ nodeId, name, url, pin }))));
  return members;
}

/** Load score of a member (0 idle, 1 full), or null when it does not answer. */
export async function memberScore(member: ClusterMember): Promise<number | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(`${member.url}/api/status`, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) return null;
    const status = await response.json() as { serverId?: string; load?: { score?: number } };
    if (status.serverId !== member.nodeId) return null;
    return typeof status.load?.score === "number" ? status.load.score : 0;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export function switchToMember(member: ClusterMember) {
  setApiBaseUrl(member.url);
  write(SERVER_ID_KEY, member.nodeId);
  if (member.name) write(SERVER_NAME_KEY, member.name);
}

/**
 * Which member to use now: the current one unless it is down, or busy while another is free.
 * Returns null when the board should stay where it is.
 */
export function chooseMember(
  members: ClusterMember[],
  scores: Map<string, number | null>,
  currentUrl: string,
): ClusterMember | null {
  const current = members.find((member) => member.url === currentUrl);
  const currentScore = current ? scores.get(current.nodeId) : null;
  const live = members
    .filter((member) => member !== current && typeof scores.get(member.nodeId) === "number")
    .sort((a, b) => (scores.get(a.nodeId)! - scores.get(b.nodeId)!) || a.nodeId.localeCompare(b.nodeId));
  const best = live[0];
  if (!best) return null;
  if (currentScore === null || currentScore === undefined) return best;
  if (currentScore > BUSY_SCORE && scores.get(best.nodeId)! < FREE_SCORE) return best;
  return null;
}

async function scoreAll(members: ClusterMember[]) {
  const entries = await Promise.all(members.map(async (member) => [member.nodeId, await memberScore(member)] as const));
  return new Map(entries);
}

/** Finds a live member when the current server stops answering; used by apiFetch's recovery. */
export async function failOverToLiveMember(): Promise<string | null> {
  const members = clusterMembers();
  if (!members.length) return null;
  const choice = chooseMember(members, await scoreAll(members), "");
  if (!choice) return null;
  switchToMember(choice);
  return choice.url;
}

let balancer: number | null = null;

/** Keeps the board on a responsive, not overloaded member. ``onSwitch`` runs after a move. */
export function startClusterBalancer(onSwitch?: (member: ClusterMember) => void): () => void {
  if (!isNativeApp() || balancer !== null) return () => undefined;
  setServerRecoveryHook(failOverToLiveMember);
  let lastRefresh = 0;
  const tick = async () => {
    try {
      if (Date.now() - lastRefresh > REFRESH_MEMBERS_EVERY_MS) {
        lastRefresh = Date.now();
        await refreshClusterMembers().catch(() => clusterMembers());
      }
      const members = clusterMembers();
      if (members.length < 2) return;
      const choice = chooseMember(members, await scoreAll(members), getApiBaseUrl());
      if (choice) {
        switchToMember(choice);
        onSwitch?.(choice);
      }
    } catch {
      // Balancing is best effort; the next tick tries again.
    }
  };
  void tick();
  balancer = window.setInterval(() => void tick(), CHECK_EVERY_MS);
  return () => {
    if (balancer !== null) window.clearInterval(balancer);
    balancer = null;
    setServerRecoveryHook(null);
  };
}
