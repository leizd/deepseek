import { createId } from "./format.js";

export function normalizeTheme(value) {
  return ["system", "light", "dark"].includes(value) ? value : "system";
}

export function normalizeThemeStyle(value) {
  return ["chatgpt", "linear", "notion", "arc"].includes(value) ? value : "chatgpt";
}

export function normalizeThemeMode(value) {
  return ["system", "light", "dark"].includes(value) ? value : "system";
}

export function normalizeFontSize(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeVoiceLanguage(value) {
  const raw = String(value || "").trim().replace(/_/g, "-");
  const lower = raw.toLowerCase();
  if (lower.startsWith("zh-hant") || lower.startsWith("zh-tw") || lower.startsWith("zh-hk") || lower.startsWith("zh-mo")) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en-gb")) return "en-GB";
  if (lower.startsWith("en")) return "en-US";
  if (lower.startsWith("ja")) return "ja-JP";
  if (lower.startsWith("ko")) return "ko-KR";
  return "zh-CN";
}

export function normalizeModel(model, supportedModels, defaultModel) {
  return supportedModels.has(model) ? model : defaultModel;
}

export function normalizeSeekId(id) {
  return String(id || "").trim();
}

export function normalizeStoredAttachment(value) {
  if (!value || typeof value !== "object") return null;
  const text = typeof value.text === "string" ? value.text : "";
  return {
    id: typeof value.id === "string" && value.id ? value.id : createId(),
    name: String(value.name || "附件").slice(0, 180),
    type: String(value.type || ""),
    size: Number(value.size) || 0,
    kind: String(value.kind || "text"),
    text,
    preview: String(value.preview || text || ""),
    thumbnail: String(value.thumbnail || ""),
    imagePreview: String(value.imagePreview || ""),
    fileId: typeof value.fileId === "string" ? value.fileId : "",
    projectId: typeof value.projectId === "string" ? value.projectId : "",
    charCount: Number(value.charCount) || 0,
    chunkCount: Number(value.chunkCount) || 0,
    chunked: Boolean(value.chunked),
    truncated: Boolean(value.truncated),
  };
}
