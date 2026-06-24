import {
  errorSpans,
  formatDuration,
  formatNumber,
  renderCategoryTable,
  renderSpanTree,
  renderTraceWaterfall,
  traceWindowText,
} from "./trace_waterfall.js";

const elements = {
  status: document.getElementById("status"),
  headline: document.getElementById("headline"),
  traceTitle: document.getElementById("traceTitle"),
  traceSubtitle: document.getElementById("traceSubtitle"),
  traceStatus: document.getElementById("traceStatus"),
  exportLink: document.getElementById("exportLink"),
  facts: document.getElementById("facts"),
  contentGrid: document.getElementById("contentGrid"),
  summaryGrid: document.getElementById("summaryGrid"),
  spanCount: document.getElementById("spanCount"),
  traceWindow: document.getElementById("traceWindow"),
  spanTree: document.getElementById("spanTree"),
  waterfall: document.getElementById("waterfall"),
  categorySummary: document.getElementById("categorySummary"),
  errors: document.getElementById("errors"),
};

init();

async function init() {
  const traceId = traceIdFromPath();
  if (!traceId) {
    showError("Trace id is missing.");
    return;
  }
  elements.exportLink.href = `/api/traces/${encodeURIComponent(traceId)}/export.json`;
  elements.exportLink.setAttribute("download", `trace-${traceId.slice(0, 32)}.json`);

  try {
    const response = await fetch(`/api/traces/${encodeURIComponent(traceId)}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Trace request failed with HTTP ${response.status}`);
    }
    renderTrace(payload.trace || {});
  } catch (error) {
    showError(error?.message || "Unable to load trace.");
  }
}

function traceIdFromPath() {
  const marker = "/trace/";
  const index = window.location.pathname.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(window.location.pathname.slice(index + marker.length)).trim();
}

function renderTrace(trace) {
  const spans = Array.isArray(trace.spans) ? trace.spans : [];
  const summary = trace.summary && typeof trace.summary === "object" ? trace.summary : {};
  const title = trace.title || trace.traceId || "Trace";
  const status = trace.status || "unknown";

  document.title = `${title} - DeepSeek Infra Trace`;
  elements.status.hidden = true;
  elements.headline.hidden = false;
  elements.facts.hidden = false;
  elements.contentGrid.hidden = false;
  elements.summaryGrid.hidden = false;

  elements.traceTitle.textContent = title;
  elements.traceSubtitle.textContent = [trace.kind, trace.traceId, dateRange(trace)].filter(Boolean).join(" / ");
  elements.traceStatus.textContent = status;
  elements.traceStatus.classList.toggle("error", Boolean(trace.error) || status === "error");

  elements.facts.replaceChildren(
    fact("Duration", formatDuration(trace.durationMs)),
    fact("Spans", formatNumber(summary.spanCount ?? spans.length)),
    fact("Tokens", formatNumber(summary.totalTokens)),
    fact("Slowest", summary.slowestSpan || "none"),
    fact("Cache Hits", formatNumber(cacheHitCount(spans)))
  );

  elements.spanCount.textContent = `${formatNumber(spans.length)} spans`;
  elements.traceWindow.textContent = traceWindowText(spans);
  elements.spanTree.replaceChildren(renderSpanTree(spans));
  elements.waterfall.replaceChildren(renderTraceWaterfall(spans));
  elements.categorySummary.replaceChildren(renderCategoryTable(spans));
  renderErrors(trace, spans);
}

function renderErrors(trace, spans) {
  elements.errors.replaceChildren();
  const errors = [];
  if (trace.error) errors.push({ name: "trace", error: trace.error });
  for (const span of errorSpans(spans)) {
    errors.push({ name: span.name || span.kind || "span", error: span.error || span.status || "error" });
  }

  if (!errors.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No errors recorded.";
    elements.errors.append(empty);
    return;
  }

  for (const item of errors) {
    const row = document.createElement("article");
    const strong = document.createElement("strong");
    strong.textContent = item.name;
    const text = document.createElement("p");
    text.textContent = item.error;
    row.append(strong, text);
    elements.errors.append(row);
  }
}

function fact(label, value) {
  const node = document.createElement("div");
  node.className = "fact";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value === undefined || value === null || value === "" ? "none" : String(value);
  node.append(key, val);
  return node;
}

function cacheHitCount(spans) {
  return (Array.isArray(spans) ? spans : []).filter((span) => {
    const status = String(span?.status || "").toLowerCase();
    return status === "hit" || Number(span?.cacheHitRate || 0) > 0 || span?.diagnostics?.cacheHit === true;
  }).length;
}

function dateRange(trace) {
  if (trace.startedAt && trace.completedAt) return `${trace.startedAt} to ${trace.completedAt}`;
  return trace.startedAt || "";
}

function showError(message) {
  elements.status.hidden = false;
  elements.status.classList.add("error");
  elements.status.textContent = message;
  elements.headline.hidden = true;
  elements.facts.hidden = true;
  elements.contentGrid.hidden = true;
  elements.summaryGrid.hidden = true;
}
