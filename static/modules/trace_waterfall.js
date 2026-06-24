const CATEGORY_ORDER = ["agent", "tool", "rag", "llm", "cache", "other"];
const CATEGORY_LABELS = {
  agent: "Agent",
  tool: "Tool / MCP",
  rag: "RAG",
  llm: "LLM",
  cache: "Cache",
  other: "Other",
};

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function traceSpanOffset(span) {
  return numberOrZero(span?.offsetMs);
}

export function buildTraceSpanTree(spans) {
  const list = Array.isArray(spans) ? spans.filter((span) => span && typeof span === "object") : [];
  const byId = new Map();
  for (const span of list) {
    if (span.spanId) byId.set(span.spanId, span);
  }

  const childrenByParent = new Map();
  const roots = [];
  for (const span of list) {
    const parentId = span.parentSpanId && byId.has(span.parentSpanId) && span.parentSpanId !== span.spanId ? span.parentSpanId : "";
    if (!parentId) {
      roots.push(span);
      continue;
    }
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(span);
  }

  const ordered = [];
  const visited = new Set();
  const walk = (span, depth) => {
    if (!span || visited.has(span.spanId)) return;
    visited.add(span.spanId);
    ordered.push({ span, depth });
    const children = (childrenByParent.get(span.spanId) || []).slice().sort((a, b) => traceSpanOffset(a) - traceSpanOffset(b));
    for (const child of children) walk(child, depth + 1);
  };

  for (const root of roots.slice().sort((a, b) => traceSpanOffset(a) - traceSpanOffset(b))) {
    walk(root, 0);
  }
  for (const span of list) {
    if (!visited.has(span.spanId)) ordered.push({ span, depth: 0 });
  }
  return ordered;
}

export function spanCategory(span) {
  const kind = String(span?.kind || "").toLowerCase();
  const name = String(span?.name || "").toLowerCase();
  const source = `${kind} ${name}`;
  if (source.includes("agent")) return "agent";
  if (source.includes("rag") || source.includes("retriev") || source.includes("citation") || source.includes("file")) return "rag";
  if (source.includes("llm") || source.includes("deepseek") || source.includes("openai") || source.includes("model")) return "llm";
  if (source.includes("cache")) return "cache";
  if (source.includes("tool") || source.includes("mcp") || source.includes("search") || source.includes("fetch")) return "tool";
  return "other";
}

export function summarizeByCategory(spans) {
  const summaries = new Map();
  for (const key of CATEGORY_ORDER) {
    summaries.set(key, { key, label: CATEGORY_LABELS[key], count: 0, durationMs: 0, tokens: 0, cacheHits: 0, errors: 0 });
  }

  for (const span of Array.isArray(spans) ? spans : []) {
    const key = spanCategory(span);
    const summary = summaries.get(key) || summaries.get("other");
    summary.count += 1;
    summary.durationMs += numberOrZero(span.durationMs);
    summary.tokens += numberOrZero(span.totalTokens);
    if (isCacheHit(span)) summary.cacheHits += 1;
    if (isErrorSpan(span)) summary.errors += 1;
  }
  return CATEGORY_ORDER.map((key) => summaries.get(key)).filter((summary) => summary && summary.count > 0);
}

export function renderCategoryTable(spans) {
  const table = document.createElement("table");
  table.className = "category-table";
  const header = document.createElement("thead");
  header.innerHTML = "<tr><th>Type</th><th>Count</th><th>Duration</th><th>Tokens</th><th>Cache</th><th>Errors</th></tr>";
  const body = document.createElement("tbody");
  for (const summary of summarizeByCategory(spans)) {
    const row = document.createElement("tr");
    appendCell(row, summary.label);
    appendCell(row, String(summary.count));
    appendCell(row, formatDuration(summary.durationMs));
    appendCell(row, formatNumber(summary.tokens));
    appendCell(row, String(summary.cacheHits));
    appendCell(row, String(summary.errors));
    body.append(row);
  }
  if (!body.children.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty";
    cell.textContent = "No spans recorded.";
    row.append(cell);
    body.append(row);
  }
  table.append(header, body);
  return table;
}

export function renderSpanTree(spans) {
  const fragment = document.createDocumentFragment();
  for (const { span, depth } of buildTraceSpanTree(spans)) {
    const row = document.createElement("article");
    row.className = "tree-row";
    row.style.marginLeft = `${Math.min(depth, 8) * 18}px`;

    const title = document.createElement("div");
    title.className = "tree-title";
    const dot = document.createElement("span");
    dot.className = `kind-dot ${spanCategory(span)}`;
    const name = document.createElement("strong");
    name.textContent = span.name || span.kind || "span";
    title.append(dot, name);

    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = spanMeta(span);
    row.append(title, meta);
    fragment.append(row);
  }
  if (!fragment.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No spans recorded.";
    fragment.append(empty);
  }
  return fragment;
}

export function renderTraceWaterfall(spans) {
  const fragment = document.createDocumentFragment();
  const ordered = buildTraceSpanTree(spans);
  const maxEnd = Math.max(
    1,
    ...ordered.map(({ span }) => numberOrZero(span.offsetMs) + Math.max(1, numberOrZero(span.durationMs)))
  );

  for (const { span, depth } of ordered) {
    const category = spanCategory(span);
    const row = document.createElement("article");
    row.className = "span-row";

    const name = document.createElement("div");
    name.className = "span-name";
    name.style.paddingLeft = `${Math.min(depth, 8) * 14}px`;
    const strong = document.createElement("strong");
    strong.textContent = span.name || span.kind || "span";
    const meta = document.createElement("span");
    meta.className = "subtle";
    meta.textContent = [CATEGORY_LABELS[category], span.kind, span.status].filter(Boolean).join(" / ");
    name.append(strong, meta);

    const lane = document.createElement("div");
    lane.className = "lane";
    const bar = document.createElement("span");
    bar.className = `bar ${category}`;
    const left = Math.min(98, Math.max(0, (numberOrZero(span.offsetMs) / maxEnd) * 100));
    const width = Math.max(1, Math.min(100 - left, (Math.max(1, numberOrZero(span.durationMs)) / maxEnd) * 100));
    bar.style.left = `${left}%`;
    bar.style.width = `${width}%`;
    lane.append(bar);

    const metrics = document.createElement("div");
    metrics.className = "span-metrics";
    metrics.textContent = spanMetrics(span);

    row.append(name, lane, metrics);
    fragment.append(row);
  }

  if (!fragment.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No spans recorded.";
    fragment.append(empty);
  }
  return fragment;
}

export function traceWindowText(spans) {
  const maxEnd = Math.max(0, ...(Array.isArray(spans) ? spans : []).map((span) => numberOrZero(span.offsetMs) + numberOrZero(span.durationMs)));
  return maxEnd ? `0ms to ${formatDuration(maxEnd)}` : "";
}

export function errorSpans(spans) {
  return (Array.isArray(spans) ? spans : []).filter((span) => isErrorSpan(span) || span?.error);
}

export function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(Number(value) || 0)));
}

function isCacheHit(span) {
  const status = String(span?.status || "").toLowerCase();
  return status === "hit" || numberOrZero(span?.cacheHitRate) > 0 || span?.diagnostics?.cacheHit === true;
}

function isErrorSpan(span) {
  const status = String(span?.status || "").toLowerCase();
  return Boolean(span?.error) || (status && !["ok", "hit", "miss", "skipped", "completed", "running"].includes(status));
}

function spanMeta(span) {
  return [span.kind, span.status, formatDuration(span.durationMs), tokenText(span), cacheText(span)].filter(Boolean).join(" / ");
}

function spanMetrics(span) {
  return [formatDuration(span.durationMs), tokenText(span), cacheText(span)].filter(Boolean).join(" / ");
}

function tokenText(span) {
  const tokens = numberOrZero(span?.totalTokens);
  return tokens ? `${formatNumber(tokens)} tokens` : "";
}

function cacheText(span) {
  const rate = numberOrZero(span?.cacheHitRate);
  if (rate) return `cache ${rate}%`;
  return isCacheHit(span) ? "cache hit" : "";
}

function appendCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
}
