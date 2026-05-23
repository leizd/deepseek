(function attachSeekCore(global) {
  const maxCustomSeeks = 40;
  const maxSeekReferenceAttachments = 6;

  function truncateCodePoints(value, maxLength) {
    return Array.from(String(value || "")).slice(0, maxLength).join("");
  }

  function normalizeSeekId(id) {
    return String(id || "").trim();
  }

  function normalizeSeekText(value, maxLength) {
    return truncateCodePoints(String(value || "").replace(/\s+/g, " ").trim(), maxLength);
  }

  function normalizeSeekInstructions(value, maxLength) {
    return truncateCodePoints(
      String(value || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      maxLength
    );
  }

  function normalizeSeekReferenceAttachment(value, options = {}) {
    if (!value || typeof value !== "object") return null;
    const name = normalizeSeekText(value.name || "参考文件", 180);
    const text = typeof value.text === "string" ? value.text : "";
    const preview = typeof value.preview === "string" ? value.preview : text;
    const fileId = typeof value.fileId === "string" ? value.fileId : "";
    if (!name || (!fileId && !text && !preview)) return null;
    const rawId = typeof value.id === "string" && value.id ? value.id : "";
    const fallbackId = options.createId ? `seek-ref-${options.createId()}` : `seek-ref-${Date.now()}`;
    return {
      id: rawId || fallbackId,
      name,
      type: normalizeSeekText(value.type, 120),
      size: Number(value.size) || 0,
      kind: normalizeSeekText(value.kind || "text", 24) || "text",
      text,
      preview,
      fileId,
      charCount: Number(value.charCount) || 0,
      chunkCount: Number(value.chunkCount) || 0,
      chunked: Boolean(value.chunked),
      truncated: Boolean(value.truncated),
    };
  }

  function normalizeSeekReferenceAttachments(values, options = {}) {
    if (!Array.isArray(values)) return [];
    return values
      .map((item) => normalizeSeekReferenceAttachment(item, options))
      .filter(Boolean)
      .slice(0, maxSeekReferenceAttachments);
  }

  function normalizeSeek(value, options = {}) {
    if (!value || typeof value !== "object") return null;
    const name = normalizeSeekText(value.name, 32);
    const instructions = normalizeSeekInstructions(value.instructions, 5000);
    if (!name || !instructions) return null;
    const now = Number(options.now) || Date.now();
    return {
      id: String(value.id || `seek-${options.createId ? options.createId() : now}`),
      name,
      description: normalizeSeekText(value.description, 140),
      instructions,
      starter: normalizeSeekText(value.starter, 160),
      referenceAttachments: normalizeSeekReferenceAttachments(value.referenceAttachments || value.seekReferenceAttachments, options),
      accent: ["blue", "green", "purple", "orange"].includes(value.accent) ? value.accent : "blue",
      builtin: false,
      createdAt: Number(value.createdAt) || now,
      updatedAt: Number(value.updatedAt) || now,
    };
  }

  function normalizeCustomSeeks(values, options = {}) {
    if (!Array.isArray(values)) return [];
    return values.map((item) => normalizeSeek(item, options)).filter(Boolean).slice(0, maxCustomSeeks);
  }

  function seekExportPayload(seeks, options = {}) {
    return {
      type: "deepseek-mobile.seeks",
      version: 2,
      exportedAt: options.exportedAt || new Date().toISOString(),
      seeks: normalizeCustomSeeks(seeks, options),
    };
  }

  function importedSeekValues(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(value.seeks)) return value.seeks;
    return [];
  }

  function uniqueSeekName(name, existingNames, maxLength = 32) {
    const normalized = normalizeSeekText(name, maxLength);
    if (!normalized) return "";
    if (!existingNames.has(normalized)) return normalized;

    for (let index = 1; index < 100; index += 1) {
      const suffix = index === 1 ? " 副本" : ` 副本 ${index}`;
      const prefix = truncateCodePoints(normalized, Math.max(1, maxLength - Array.from(suffix).length));
      const candidate = `${prefix}${suffix}`;
      if (!existingNames.has(candidate)) return candidate;
    }
    return "";
  }

  function uniqueSeekId(id, existingIds, options = {}) {
    const normalized = normalizeSeekId(id);
    if (normalized && !existingIds.has(normalized)) return normalized;
    for (let index = 0; index < 100; index += 1) {
      const raw = options.createId ? options.createId() : `${Date.now()}-${index}`;
      const candidate = `seek-${raw}`;
      if (!existingIds.has(candidate)) return candidate;
    }
    return `seek-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function mergeImportedSeeks(currentSeeks, importPayload, existingSeeks = [], options = {}) {
    const now = Number(options.now) || Date.now();
    const current = normalizeCustomSeeks(currentSeeks, options);
    const existing = [...existingSeeks, ...current];
    const existingNames = new Set(existing.map((seek) => normalizeSeekText(seek.name, 32)).filter(Boolean));
    const existingIds = new Set(existing.map((seek) => normalizeSeekId(seek.id)).filter(Boolean));
    const imported = [];
    let skippedCount = 0;

    for (const raw of importedSeekValues(importPayload)) {
      if (current.length + imported.length >= maxCustomSeeks) {
        skippedCount += 1;
        continue;
      }
      const normalized = normalizeSeek(raw, { ...options, now });
      if (!normalized) {
        skippedCount += 1;
        continue;
      }
      normalized.id = uniqueSeekId(normalized.id, existingIds, options);
      normalized.name = uniqueSeekName(normalized.name, existingNames, 32);
      if (!normalized.name) {
        skippedCount += 1;
        continue;
      }
      normalized.builtin = false;
      normalized.createdAt = Number(normalized.createdAt) || now;
      normalized.updatedAt = now;
      existingIds.add(normalized.id);
      existingNames.add(normalized.name);
      imported.push(normalized);
    }

    return {
      seeks: [...imported, ...current].slice(0, maxCustomSeeks),
      importedCount: imported.length,
      skippedCount,
    };
  }

  function seekSnapshotFromSeek(seek) {
    return {
      seekId: normalizeSeekId(seek?.id),
      seekName: normalizeSeekText(seek?.name, 32),
      seekDescription: normalizeSeekText(seek?.description, 140),
      seekInstructions: normalizeSeekInstructions(seek?.instructions, 5000),
      seekReferenceAttachments: normalizeSeekReferenceAttachments(seek?.referenceAttachments),
    };
  }

  function seekSnapshotFromMessage(message) {
    return {
      seekId: normalizeSeekId(message?.seekId),
      seekName: normalizeSeekText(message?.seekName, 32),
      seekDescription: normalizeSeekText(message?.seekDescription, 140),
      seekInstructions: normalizeSeekInstructions(message?.seekInstructions, 5000),
      seekReferenceAttachments: normalizeSeekReferenceAttachments(message?.seekReferenceAttachments),
    };
  }

  function resolveSeekContext(source, seeks = []) {
    if (source && typeof source === "object") {
      const snapshot = seekSnapshotFromMessage(source);
      if (snapshot.seekName && snapshot.seekInstructions) {
        return {
          id: snapshot.seekId,
          name: snapshot.seekName,
          description: snapshot.seekDescription,
          instructions: snapshot.seekInstructions,
          referenceAttachments: snapshot.seekReferenceAttachments,
          accent: "blue",
        };
      }
      if (source.name && source.instructions) {
        return {
          id: normalizeSeekId(source.id),
          name: normalizeSeekText(source.name, 32),
          description: normalizeSeekText(source.description, 140),
          instructions: normalizeSeekInstructions(source.instructions, 5000),
          referenceAttachments: normalizeSeekReferenceAttachments(
            source.referenceAttachments || source.seekReferenceAttachments
          ),
          accent: source.accent || "blue",
        };
      }
      return findSeekById(seeks, source.seekId);
    }
    return findSeekById(seeks, source);
  }

  function findSeekById(seeks, id) {
    const normalized = normalizeSeekId(id);
    return normalized ? seeks.find((seek) => seek.id === normalized) || null : null;
  }

  function seekNameForMessage(message, seeks = []) {
    const snapshot = seekSnapshotFromMessage(message);
    return snapshot.seekName || findSeekById(seeks, snapshot.seekId)?.name || "";
  }

  function hasDuplicateSeekName(seeks, name, editingId = "") {
    const normalizedName = normalizeSeekText(name, 32);
    const normalizedId = normalizeSeekId(editingId);
    return Boolean(normalizedName && seeks.some((seek) => seek.id !== normalizedId && seek.name === normalizedName));
  }

  function latestKnownSeekId(messages, knownSeeks = []) {
    const knownIds = new Set(knownSeeks.map((seek) => seek.id));
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const seekId = normalizeSeekId(messages[index]?.seekId);
      if (knownIds.has(seekId)) return seekId;
    }
    return "";
  }

  global.DeepSeekSeekCore = Object.freeze({
    maxCustomSeeks,
    maxSeekReferenceAttachments,
    truncateCodePoints,
    normalizeSeekId,
    normalizeSeekText,
    normalizeSeekInstructions,
    normalizeSeekReferenceAttachment,
    normalizeSeekReferenceAttachments,
    normalizeSeek,
    normalizeCustomSeeks,
    seekExportPayload,
    mergeImportedSeeks,
    uniqueSeekName,
    seekSnapshotFromSeek,
    seekSnapshotFromMessage,
    resolveSeekContext,
    findSeekById,
    seekNameForMessage,
    hasDuplicateSeekName,
    latestKnownSeekId,
  });
})(globalThis);
