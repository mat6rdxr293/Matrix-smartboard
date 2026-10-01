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
export const CLIENT_API_VERSION = 2;

export type ServerStatus = {
  ok?: boolean;
  product?: string;
  serverVersion?: string;
  apiVersion?: number;
  minClientApiVersion?: number;
  serverId?: string;
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
  installLocalAi: boolean;
};

type SshProvisionerPlugin = {
  inspectHost(options: InspectHostOptions): Promise<{ fingerprint: string }>;
  provisionServer(options: ProvisionOptions): Promise<{ serverUrl: string; exitCode: number }>;
  addListener(eventName: "provisionProgress", listener: (event: { line: string }) => void): Promise<PluginListenerHandle>;
};

export const SshProvisioner = registerPlugin<SshProvisionerPlugin>("SshProvisioner");

export const needsAndroidSetup = () => {
  if (!isNativeApp()) return false;
  return typeof window !== "undefined" && window.localStorage.getItem(SETUP_KEY) !== "1";
};

export const finishAndroidSetup = (serverUrl: string) => {
  setApiBaseUrl(serverUrl);
  setMobileSessionToken(null);
  if (typeof window !== "undefined") window.localStorage.setItem(SETUP_KEY, "1");
};

export const currentServerUrl = () => getApiBaseUrl();

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
  if (isNativeApp() && normalized.startsWith("https://")) {
    await NativeSecurity.trustServer({ serverUrl: normalized, serverId, pin });
  }
  if (typeof window !== "undefined") window.localStorage.setItem(SERVER_ID_KEY, serverId);
  setApiBaseUrl(normalized);
  setMobileSessionToken(null);
};

export const testServer = async (serverUrl: string) => {
  const probe = await probeServerIdentity(serverUrl);
  if (probe.serverUrl.startsWith("https://") && isNativeApp() && !probe.alreadyTrusted) {
    return { ...probe, needsTrust: true as const };
  }

  setApiBaseUrl(probe.serverUrl);
  if (probe.serverId && typeof window !== "undefined") window.localStorage.setItem(SERVER_ID_KEY, probe.serverId);
  setMobileSessionToken(null);
  const response = await apiFetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error(`Сервер ответил кодом ${response.status}`);
  const status = await response.json() as ServerStatus;
  validateStatus(status);
  return { ...probe, status, needsTrust: false as const };
};
