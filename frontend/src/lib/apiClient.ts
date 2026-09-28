import { Capacitor } from "@capacitor/core";

const API_BASE_KEY = "matrix.apiBaseUrl";
const MOBILE_SESSION_KEY = "matrix.mobileSessionToken";

const normalizeBase = (value: string | null | undefined) => {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
};

export const isNativeApp = () => Capacitor.isNativePlatform();

export const getApiBaseUrl = () => {
  if (typeof window !== "undefined") {
    const stored = normalizeBase(window.localStorage.getItem(API_BASE_KEY));
    if (stored) return stored;
  }
  return normalizeBase(import.meta.env.VITE_API_BASE_URL);
};

export const setApiBaseUrl = (value: string) => {
  const normalized = normalizeBase(value);
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

export async function apiFetch(path: string, init: RequestInit = {}) {
  const native = isNativeApp();
  const headers = new Headers(init.headers);
  if (native) {
    headers.set("X-Matrix-Mobile", "1");
    const token = getMobileSessionToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  return fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: init.credentials ?? (native ? "omit" : "same-origin"),
  });
}
