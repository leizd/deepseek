import { normalizeCodeLanguage } from "./markdown.js";

export function extensionForLanguage(lang) {
  const extensions = {
    bash: "sh",
    c: "c",
    cpp: "cpp",
    csharp: "cs",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    javascript: "js",
    json: "json",
    python: "py",
    sql: "sql",
    typescript: "ts",
  };
  return extensions[normalizeCodeLanguage(lang)] || "txt";
}

export function vscodeUriForPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `vscode://file/${normalized}`;
  return `vscode://file${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export function safeFilename(value) {
  return (
    String(value || "deepseek-chat")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "deepseek-chat"
  );
}

export function fileKindFromName(name) {
  const extension = String(name || "").split(".").pop() || "file";
  return extension.slice(0, 12).toLowerCase();
}

export function createId() {
  const cryptoSource = globalThis.crypto || globalThis.window?.crypto;
  if (cryptoSource?.randomUUID) return cryptoSource.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function quoteAwareContent(content, quoteDraft) {
  const quoteText = quoteDraft?.isFragment ? quoteDraft.fragment || quoteDraft.text : quoteDraft?.text;
  if (!quoteText) return content;
  const quoted = String(quoteText)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  if (quoteDraft?.isFragment) {
    return `关于上文中的这一段：\n\n${quoted}\n\n${content}`.trim();
  }
  return `针对这段内容提问：\n\n${quoted}\n\n${content}`.trim();
}

export function tailForContinuation(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}
