export type PresentationSource = {
  type: "local" | "m365" | "office";
  mode: "view" | "edit";
  access: "private" | "public";
  embedUrl: string | null;
  fileId: string | null;
  lastSyncTs: number | null;
  fallbackPdf: string[];
};

export const DEFAULT_PRESENTATION_SOURCE: PresentationSource = {
  type: "local",
  mode: "view",
  access: "private",
  embedUrl: null,
  fileId: null,
  lastSyncTs: null,
  fallbackPdf: [],
};

export const isPresentationSource = (value: unknown): value is PresentationSource => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "local" || v.type === "m365" || v.type === "office") &&
    (v.mode === "view" || v.mode === "edit") &&
    (v.access === "private" || v.access === "public") &&
    (v.embedUrl === null || typeof v.embedUrl === "string") &&
    (v.fileId === null || typeof v.fileId === "string") &&
    (v.lastSyncTs === null || typeof v.lastSyncTs === "number") &&
    Array.isArray(v.fallbackPdf)
  );
};
