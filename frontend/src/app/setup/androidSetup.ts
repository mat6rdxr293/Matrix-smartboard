import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  apiFetch,
  getApiBaseUrl,
  isNativeApp,
  normalizeServerBase,
  setApiBaseUrl,
  setMobileSessionToken,
  NativeDiscovery,
  NativeSecurity,
} from "@/lib/apiClient";

const SETUP_KEY = "matrix.androidSetupComplete";
const SERVER_ID_KEY = "matrix.serverId";
const SERVER_NAME_KEY = "matrix.serverName";
export const CLIENT_API_VERSION = 2;

export type ServerStatus = {
  ok?: boolean;
  product?: string;
  serverVersion?: string;
  apiVersion?: number;
  minClientApiVersion?: number;
  serverId?: string;
  serverName?: string;
  publicKeyPin?: string;
  tls?: boolean;
  ai?: boolean;
  ocr?: boolean;
};

export type DiscoveredServer = {
  name: string;
  serverId: string;
  serverUrl: string;
  host: string;
  port: number;
  tls: boolean;
  apiVersion: number;
  serverVersion: string;
};

type InspectHostOptions = {
  host: string;
  port: number;
  username: string;
  password: string;
};

type ProvisionOptions = InspectHostOptions & {
  sudoPassword?: string;
  expectedFingerprint: string;
  backendPort: number;
  serverName: string;
  installLocalAi: boolean;
};

type SshProvisionerPlugin = {
  inspectHost(options: InspectHostOptions): Promise<{ fingerprint: string }>;
  provisionServer(options: ProvisionOptions): Promise<{ serverUrl: string; exitCode: number }>;
  addListener(eventName: "provisionProgress", listener: (event: { line: string }) => void): Promise<PluginListenerHandle>;
};

export type ConnectionCheckState = "ok" | "failed" | "skipped";

export type SavedServerConnectionResult = {
  ok: boolean;
  reason:
    | "connected"
    | "not-configured"
    | "server-not-found"
    | "server-found-unreachable"
    | "identity-changed"
    | "incompatible"
    | "discovery-unavailable";
  serverName: string;
  serverUrl: string;
  detail?: string;
  source?: "saved-address" | "mdns";
  status?: ServerStatus;
  checks: {
    savedAddress: ConnectionCheckState;
    discovery: ConnectionCheckState;
    identity: ConnectionCheckState;
    backend: ConnectionCheckState;
  };
};

export const SshProvisioner = registerPlugin<SshProvisionerPlugin>("SshProvisioner");

const readStored = (key: string) => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

const writeStored = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in embedded/private contexts.
  }
};

export const needsAndroidSetup = () => {
  if (!isNativeApp()) return false;
  return readStored(SETUP_KEY) !== "1";
};

export const finishAndroidSetup = (serverUrl: string) => {
  setApiBaseUrl(serverUrl);
  writeStored(SETUP_KEY, "1");
};

export const currentServerUrl = () => getApiBaseUrl();
export const currentServerName = () => readStored(SERVER_NAME_KEY);

export const discoverServers = async (timeoutMs = 2500): Promise<DiscoveredServer[]> => {
  if (!isNativeApp()) return [];
  const result = await NativeDiscovery.discover({ timeoutMs });
  return (result.servers ?? [])
    .filter((item) => item.serverId && item.serverUrl)
    .map((item) => ({
      name: item.name ?? "Matrix Smartboard",
      serverId: item.serverId,
      serverUrl: item.serverUrl,
      host: item.host ?? "",
      port: item.port ?? 8443,
      tls: item.tls ?? true,
      apiVersion: item.apiVersion ?? 0,
      serverVersion: item.serverVersion ?? "",
    }));
};

const validateStatus = (status: ServerStatus) => {
  if (!status.ok || status.product !== "matrix-smartboard") throw new Error("Это не Matrix Smartboard server");
  const apiVersion = Number(status.apiVersion ?? 0);
  const minClient = Number(status.minClientApiVersion ?? 1);
  if (apiVersion < CLIENT_API_VERSION) throw new Error("Версия сервера устарела. Обновите Matrix Smartboard Server.");
  if (minClient > CLIENT_API_VERSION) throw new Error("Этот APK устарел. Нужна более новая версия Matrix Smartboard.");
};

const rememberServer = (serverUrl: string, serverId: string, status?: ServerStatus) => {
  setApiBaseUrl(serverUrl);
  if (serverId) writeStored(SERVER_ID_KEY, serverId);
  const serverName = status?.serverName?.trim();
  if (serverName) writeStored(SERVER_NAME_KEY, serverName);
};

const compatibilityReason = (detail: string) =>
  /Версия сервера устарела|Этот APK устарел/i.test(detail) ? "incompatible" as const : null;

export const probeServerIdentity = async (serverUrl: string) => {
  const normalized = normalizeServerBase(serverUrl);
  if (!normalized) throw new Error("Некорректный адрес сервера");
  if (isNativeApp() && normalized.startsWith("http://")) {
    throw new Error("Android-клиент принимает только защищённые https:// серверы");
  }
  if (!isNativeApp()) {
    setApiBaseUrl(normalized);
    const response = await apiFetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`Сервер ответил кодом ${response.status}`);
    const status = await response.json() as ServerStatus;
    validateStatus(status);
    return {
      serverUrl: normalized,
      status,
      pin: status.publicKeyPin ?? "",
      serverId: status.serverId ?? "",
      alreadyTrusted: normalized.startsWith("http://"),
    };
  }

  const result = await NativeSecurity.probeServer({ serverUrl: normalized });
  const status = result.status as ServerStatus;
  validateStatus(status);
  return { ...result, status, serverUrl: normalized };
};

export const trustServerIdentity = async (serverUrl: string, serverId: string, pin: string) => {
  const normalized = normalizeServerBase(serverUrl);
  if (!normalized || !serverId || !pin) throw new Error("Недостаточно данных для доверия серверу");
  const previousServerId = readStored(SERVER_ID_KEY);
  if (isNativeApp() && normalized.startsWith("https://")) {
    await NativeSecurity.trustServer({ serverUrl: normalized, serverId, pin });
  }
  if (previousServerId && previousServerId !== serverId) setMobileSessionToken(null);
  rememberServer(normalized, serverId);
};

export const testServer = async (serverUrl: string) => {
  const probe = await probeServerIdentity(serverUrl);
  if (probe.serverUrl.startsWith("https://") && isNativeApp() && !probe.alreadyTrusted) {
    return { ...probe, needsTrust: true as const };
  }

  const previousServerId = readStored(SERVER_ID_KEY);
  if (previousServerId && probe.serverId && previousServerId !== probe.serverId) setMobileSessionToken(null);
  rememberServer(probe.serverUrl, probe.serverId, probe.status);
  const response = await apiFetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error(`Сервер ответил кодом ${response.status}`);
  const status = await response.json() as ServerStatus;
  validateStatus(status);
  rememberServer(probe.serverUrl, probe.serverId, status);
  return { ...probe, status, needsTrust: false as const };
};

export const reconnectSavedServer = async (discoveryTimeoutMs = 6500): Promise<SavedServerConnectionResult> => {
  const serverId = readStored(SERVER_ID_KEY);
  const lastUrl = getApiBaseUrl();
  const storedName = readStored(SERVER_NAME_KEY) || "Matrix Smartboard";
  const checks: SavedServerConnectionResult["checks"] = {
    savedAddress: "failed",
    discovery: "skipped",
    identity: "skipped",
    backend: "skipped",
  };

  if (!isNativeApp()) {
    return {
      ok: true,
      reason: "connected",
      serverName: storedName,
      serverUrl: lastUrl,
      source: "saved-address",
      checks: { savedAddress: "ok", discovery: "skipped", identity: "ok", backend: "ok" },
    };
  }

  if (!serverId || !lastUrl) {
    return { ok: false, reason: "not-configured", serverName: storedName, serverUrl: lastUrl, checks };
  }

  let lastDetail = "";
  let savedAddressIdentityMismatch = false;
  try {
    const probe = await probeServerIdentity(lastUrl);
    checks.savedAddress = "ok";
    if (probe.serverId !== serverId || !probe.alreadyTrusted) {
      checks.identity = "failed";
      savedAddressIdentityMismatch = true;
      lastDetail = "Server identity changed";
    } else {
      checks.identity = "ok";
      checks.backend = "ok";
      rememberServer(lastUrl, serverId, probe.status);
      return {
        ok: true,
        reason: "connected",
        serverName: probe.status.serverName || storedName,
        serverUrl: lastUrl,
        status: probe.status,
        source: "saved-address",
        checks,
      };
    }
  } catch (error) {
    lastDetail = error instanceof Error ? error.message : String(error);
    const incompatible = compatibilityReason(lastDetail);
    if (incompatible) {
      return { ok: false, reason: incompatible, serverName: storedName, serverUrl: lastUrl, detail: lastDetail, checks };
    }
  }

  let discovered: DiscoveredServer[] = [];
  try {
    discovered = await discoverServers(discoveryTimeoutMs);
  } catch (error) {
    checks.discovery = "failed";
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: savedAddressIdentityMismatch ? "identity-changed" : "discovery-unavailable",
      serverName: storedName,
      serverUrl: lastUrl,
      detail,
      checks,
    };
  }

  const candidates = discovered.filter((candidate) => candidate.serverId === serverId);
  if (candidates.length === 0) {
    checks.discovery = "failed";
    return {
      ok: false,
      reason: savedAddressIdentityMismatch ? "identity-changed" : "server-not-found",
      serverName: storedName,
      serverUrl: lastUrl,
      detail: lastDetail,
      checks,
    };
  }

  checks.discovery = "ok";
  for (const candidate of candidates) {
    try {
      const probe = await probeServerIdentity(candidate.serverUrl);
      if (probe.serverId !== serverId || !probe.alreadyTrusted) {
        checks.identity = "failed";
        return {
          ok: false,
          reason: "identity-changed",
          serverName: candidate.name || storedName,
          serverUrl: candidate.serverUrl,
          checks,
        };
      }

      checks.identity = "ok";
      checks.backend = "ok";
      rememberServer(candidate.serverUrl, serverId, probe.status);
      return {
        ok: true,
        reason: "connected",
        serverName: probe.status.serverName || candidate.name || storedName,
        serverUrl: candidate.serverUrl,
        status: probe.status,
        source: "mdns",
        checks,
      };
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      const incompatible = compatibilityReason(lastDetail);
      if (incompatible) {
        return {
          ok: false,
          reason: incompatible,
          serverName: candidate.name || storedName,
          serverUrl: candidate.serverUrl,
          detail: lastDetail,
          checks,
        };
      }
    }
  }

  checks.identity = "failed";
  checks.backend = "failed";
  return {
    ok: false,
    reason: "server-found-unreachable",
    serverName: candidates[0]?.name || storedName,
    serverUrl: candidates[0]?.serverUrl || lastUrl,
    detail: lastDetail,
    checks,
  };
};
