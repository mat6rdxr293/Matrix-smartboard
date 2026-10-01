import { apiFetch } from "@/lib/apiClient";

export type ServerManagementStatus = {
  serverName: string;
  hostname: string;
  platform: string;
  platformRelease: string;
  python: string;
  uptimeSeconds: number;
  cpu: { logicalCores: number; physicalCores: number; percent: number };
  memory: { total: number; used: number; available: number; percent: number };
  disk: { total: number; used: number; free: number; percent: number };
  gpu?: {
    name?: string;
    memoryTotalMiB?: number;
    memoryUsedMiB?: number;
    utilizationPercent?: number;
  } | null;
  services: { backend: boolean; ollama: boolean };
  capabilities: {
    restartBackend: boolean;
    restartOllama: boolean;
    update: boolean;
    backupRestore: boolean;
  };
  models: Array<{ name: string; size: number; modifiedAt?: string | null }>;
  expectedModels: string[];
  update: ServerUpdateInfo;
};

export type ServerUpdateInfo = {
  localSha: string;
  latestSha: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  method?: string;
  error?: string | null;
};

export type ServerLogs = { backend: string; ollama: string; update: string };

export type ModelJobs = {
  jobs: Record<string, {
    state: "running" | "done" | "error";
    startedAt?: number;
    finishedAt?: number;
    error?: string | null;
  }>;
};

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.clone().json() as { detail?: unknown };
      if (payload.detail) detail = String(payload.detail);
    } catch {
      try {
        const text = await response.text();
        if (text.trim()) detail = text.trim();
      } catch {}
    }
    throw new Error(detail);
  }
  return await response.json() as T;
}

export const serverManagementApi = {
  async status() {
    const started = performance.now();
    const response = await apiFetch("/api/server/management/status", { cache: "no-store" });
    const data = await expectJson<ServerManagementStatus>(response);
    return { data, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  },

  async logs() {
    return expectJson<ServerLogs>(
      await apiFetch("/api/server/management/logs", { cache: "no-store" }),
    );
  },

  async updateInfo(force = false) {
    return expectJson<ServerUpdateInfo>(
      await apiFetch(`/api/server/management/update?force=${force ? "true" : "false"}`, { cache: "no-store" }),
    );
  },

  async startUpdate() {
    return expectJson<{ ok: boolean; started: boolean }>(
      await apiFetch("/api/server/management/update", { method: "POST" }),
    );
  },

  async restart(service: "backend" | "ollama") {
    return expectJson<{ ok: boolean; restarting: boolean }>(
      await apiFetch("/api/server/management/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      }),
    );
  },

  async pullModel(model: string) {
    return expectJson<{ ok: boolean; model: string; state: string }>(
      await apiFetch("/api/server/management/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      }),
    );
  },

  async modelJobs() {
    return expectJson<ModelJobs>(
      await apiFetch("/api/server/management/models/pull", { cache: "no-store" }),
    );
  },

  async createBackup() {
    const response = await apiFetch("/api/server/backup", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  },

  async restoreBackup(file: File) {
    const form = new FormData();
    form.append("file", file, file.name);
    return expectJson<{
      ok: boolean;
      restored: string[];
      configRestored: boolean;
      restartRequired: boolean;
    }>(
      await apiFetch("/api/server/restore", {
        method: "POST",
        body: form,
      }),
    );
  },
};
