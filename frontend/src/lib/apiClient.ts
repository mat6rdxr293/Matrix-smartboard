import { Capacitor, registerPlugin } from "@capacitor/core";

const API_BASE_KEY = "matrix.apiBaseUrl";
const MOBILE_SESSION_KEY = "matrix.mobileSessionToken";
const SERVER_ID_KEY = "matrix.serverId";

export type NativeDiscoveryCandidate = {
  name?: string;
  serverId: string;
  serverUrl: string;
  host?: string;
  port?: number;
  tls?: boolean;
  apiVersion?: number;
  serverVersion?: string;
};
export type NativeServerProbe = {
  serverUrl: string;
  pin: string;
  serverId: string;
  alreadyTrusted: boolean;
  status: Record<string, unknown>;
};
type DiscoveryPlugin = {
  discover(options?: { timeoutMs?: number }): Promise<{ servers: NativeDiscoveryCandidate[] }>;
};
type SecurityPlugin = {
  probeServer(options: { serverUrl: string }): Promise<NativeServerProbe>;
  trustServer(options: { serverUrl: string; serverId: string; pin: string }): Promise<void>;
  forgetServer(options: { serverId: string }): Promise<void>;
};

export const NativeDiscovery = registerPlugin<DiscoveryPlugin>("ServerDiscovery");
export const NativeSecurity = registerPlugin<SecurityPlugin>("ServerSecurity");

export const normalizeServerBase = (value: string | null | undefined) => {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.port) url.port = url.protocol === "https:" ? "8443" : "8001";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
};

export const isNativeApp = () => Capacitor.isNativePlatform();

export const getApiBaseUrl = () => {
  if (typeof window !== "undefined") {
    const stored = normalizeServerBase(window.localStorage.getItem(API_BASE_KEY));
    if (stored) return stored;
  }
  return normalizeServerBase(import.meta.env.VITE_API_BASE_URL);
};

export const setApiBaseUrl = (value: string) => {
  const normalized = normalizeServerBase(value);
  if (typeof window !== "undefined") {
    if (normalized) window.localStorage.setItem(API_BASE_KEY, normalized);
    else window.localStorage.removeItem(API_BASE_KEY);
  }
  return normalized;
};

export const getMobileSessionToken = () =>
  typeof window === "undefined" ? "" : (window.localStorage.getItem(MOBILE_SESSION_KEY) ?? "");

export const setMobileSessionToken = (token: string | null | undefined) => {
  if (typeof window === "undefined") return;
  if (token?.trim()) window.localStorage.setItem(MOBILE_SESSION_KEY, token.trim());
  else window.localStorage.removeItem(MOBILE_SESSION_KEY);
};

export const apiUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) return path;
  const base = getApiBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
};

export const backendAssetUrl = (value: string | null | undefined) => {
  if (!value) return value ?? "";
  return value.startsWith("/api/") ? apiUrl(value) : value;
};

let recoveryInFlight: Promise<string | null> | null = null;

async function recoverTrustedServerUrl(): Promise<string | null> {
  if (!isNativeApp() || typeof window === "undefined") return null;
  const serverId = window.localStorage.getItem(SERVER_ID_KEY);
  if (!serverId) return null;
  if (recoveryInFlight) return recoveryInFlight;

  recoveryInFlight = (async () => {
    try {
      const found = await NativeDiscovery.discover({ timeoutMs: 5000 });
      for (const candidate of found.servers ?? []) {
        if (candidate.serverId !== serverId || !candidate.serverUrl?.startsWith("https://")) continue;
        try {
          const probe = await NativeSecurity.probeServer({ serverUrl: candidate.serverUrl });
          if (probe.serverId === serverId && probe.alreadyTrusted) {
            return setApiBaseUrl(candidate.serverUrl);
          }
        } catch {
          // Keep trying other interfaces/addresses for the same server identity.
        }
      }
      return null;
    } finally {
      recoveryInFlight = null;
    }
  })();

  return recoveryInFlight;
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const native = isNativeApp();
  const headers = new Headers(init.headers);
  if (native) {
    headers.set("X-Matrix-Mobile", "1");
    const token = getMobileSessionToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const requestInit: RequestInit = {
    ...init,
    headers,
    credentials: init.credentials ?? (native ? "omit" : "same-origin"),
  };

  try {
    return await fetch(apiUrl(path), requestInit);
  } catch (error) {
    const base = getApiBaseUrl();
    if (!native || !base.startsWith("https://")) throw error;

    const recovered = await recoverTrustedServerUrl();
    if (!recovered) throw error;

    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      // Endpoint is repaired for the next request, but mutating requests are
      // never replayed automatically because the first attempt may have arrived.
      throw error;
    }
    return fetch(apiUrl(path), requestInit);
  }
}
