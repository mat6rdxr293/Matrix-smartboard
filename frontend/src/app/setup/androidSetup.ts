import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { apiFetch, getApiBaseUrl, isNativeApp, setApiBaseUrl, setMobileSessionToken } from "@/lib/apiClient";

const SETUP_KEY = "matrix.androidSetupComplete";

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

export const testServer = async (serverUrl: string) => {
  const normalized = setApiBaseUrl(serverUrl);
  if (!normalized) throw new Error("Некорректный адрес сервера");
  setMobileSessionToken(null);
  const response = await apiFetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error(`Сервер ответил кодом ${response.status}`);
  const status = await response.json() as { ok?: boolean; ai?: boolean; ocr?: boolean };
  if (!status.ok) throw new Error("Сервер не готов");
  return { serverUrl: normalized, status };
};
