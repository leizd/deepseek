const mathCore = window.DeepSeekMathCore;

export function formatContent(value, options = {}) {
  return renderMarkdown(value, options);
}

export function renderMarkdown(value, { streaming = false } = {}) {
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let inMathBlock = false;
  let mathFence = "";
  let mathLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    html.push(`<${listType}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${listType}>`);
    listType = null;
    listItems = [];
  };

  const flushQuote = () => {
    if (!quoteLines.length) return;
    html.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"), { streaming })}</blockquote>`);
    quoteLines = [];
  };

  const flushCode = () => {
    html.push(renderCodeBlock(codeLines.join("\n"), codeLang));
    inCode = false;
    codeLang = "";
    codeLines = [];
  };

  const flushPendingCodeAsText = () => {
    paragraph.push(`\`\`\`${codeLang}`.trimEnd(), ...codeLines);
    inCode = false;
    codeLang = "";
    codeLines = [];
  };

  const flushMathBlock = () => {
    html.push(renderMathBlock(mathLines.join("\n")));
    inMathBlock = false;
    mathFence = "";
    mathLines = [];
  };

  const flushPendingMathBlockAsText = () => {
    paragraph.push(mathFence === "$$" ? "$$" : "\\[", ...mathLines);
    inMathBlock = false;
    mathFence = "";
    mathLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (inMathBlock) {
      if ((mathFence === "$$" && trimmed === "$$") || (mathFence === "\\]" && trimmed === "\\]")) {
        flushMathBlock();
      } else {
        mathLines.push(line);
      }
      continue;
    }

    if (inCode) {
      if (/^```/.test(trimmed)) {
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_+#.-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();
      inCode = true;
      codeLang = fence[1] || "";
      continue;
    }

    const singleLineDollarMath = trimmed.match(/^\$\$([\s\S]+)\$\$$/);
    if (singleLineDollarMath) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push(renderMathBlock(singleLineDollarMath[1]));
      continue;
    }

    const singleLineBracketMath = trimmed.match(/^\\\[([\s\S]+)\\\]$/);
    if (singleLineBracketMath) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push(renderMathBlock(singleLineBracketMath[1]));
      continue;
    }

    if (trimmed === "$$" || trimmed === "\\[") {
      flushParagraph();
      flushList();
      flushQuote();
      inMathBlock = true;
      mathFence = trimmed === "$$" ? "$$" : "\\]";
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (isTableHeader(lines, index)) {
      flushParagraph();
      flushList();
      flushQuote();
      const table = collectTable(lines, index);
      html.push(renderTable(table.rows));
      index = table.nextIndex - 1;
      continue;
    }

    if (/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      const [, hashes, text] = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
      html.push(`<h${hashes.length}>${renderInline(text)}</h${hashes.length}>`);
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push("<hr>");
      continue;
    }

    const quote = line.match(/^ {0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }

    const unordered = line.match(/^ {0,3}[-*+]\s+(.+)$/);
    const ordered = line.match(/^ {0,3}\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }

    paragraph.push(line);
  }

  if (inCode) {
    if (streaming) flushPendingCodeAsText();
    else flushCode();
  }
  if (inMathBlock) {
    if (streaming) flushPendingMathBlockAsText();
    else flushMathBlock();
  }
  flushParagraph();
  flushList();
  flushQuote();

  return html.join("");
}

export function renderInline(value) {
  const codeSpans = [];
  let text = String(value).replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  const mathSpans = [];
  text = mathCore.extractInlineMath(text)
    .map((segment) => {
      if (segment.type !== "math") return segment.value;
      const token = `\u0000MATH${mathSpans.length}\u0000`;
      mathSpans.push(renderMathInline(segment.value));
      return token;
    })
    .join("");

  text = escapeHtml(text);
  // text is already HTML-escaped above, so href/label are safe in attribute/content context.
  // Re-escaping href would double-encode "&" in query strings (&amp; -> &amp;amp;) and break the link.
  text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/api\/download\?id=)[^)\s]+)\)/g, (_, label, href) => {
    const downloadId = generatedDownloadIdFromHref(href);
    if (downloadId) {
      const localHref = `/api/download?id=${downloadId}`;
      return `<a href="${localHref}" class="download-link" data-download-id="${downloadId}" download>${label}</a>`;
    }
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (_, id) => {
    const variant = /^W\d+$/i.test(id) ? " citation-web" : /^F\d+-\d+$/i.test(id) ? " citation-file" : "";
    return `<button class="citation-pin${variant}" type="button" data-citation="${escapeAttribute(id)}">[${escapeHtml(id)}]</button>`;
  });

  return text
    .replace(/\u0000MATH(\d+)\u0000/g, (_, index) => mathSpans[Number(index)] || "")
    .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSpans[Number(index)] || "");
}

function renderMathInline(value) {
  return mathCore.renderMathExpression(value, false);
}

function renderMathBlock(value) {
  const source = String(value || "").trim();
  return `
    <div class="math-block-wrap">
      <button class="math-copy-button" type="button" data-math-action="copy" aria-label="复制公式源码">复制 LaTeX</button>
      <textarea class="math-source" hidden>${escapeHtml(source)}</textarea>
      ${mathCore.renderMathExpression(source, true)}
    </div>
  `;
}

function isTableHeader(lines, index) {
  if (index + 1 >= lines.length) return false;
  return parseTableRow(lines[index]).length > 1 && isTableSeparator(lines[index + 1]);
}

function isTableSeparator(line) {
  const cells = parseTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function collectTable(lines, startIndex) {
  const rows = [parseTableRow(lines[startIndex])];
  let index = startIndex + 2;
  while (index < lines.length && parseTableRow(lines[index]).length > 1 && lines[index].trim()) {
    rows.push(parseTableRow(lines[index]));
    index += 1;
  }
  return { rows, nextIndex: index };
}

function renderTable(rows) {
  const [head, ...body] = rows;
  const header = `<thead><tr>${head.map((cell) => `<th>${renderInline(cell.trim())}</th>`).join("")}</tr></thead>`;
  const rowsHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell.trim())}</td>`).join("")}</tr>`)
    .join("");
  const chartTools = hasChartableTable(rows)
    ? `<div class="table-tools">
        <button type="button" data-chart-action="bar">柱状图</button>
        <button type="button" data-chart-action="line">折线图</button>
        <button type="button" data-chart-action="pie">饼图</button>
      </div><div class="table-chart" hidden></div>`
    : "";
  return `<div class="table-wrap">${chartTools}<table>${header}<tbody>${rowsHtml}</tbody></table></div>`;
}

function renderCodeBlock(code, lang) {
  const normalizedLang = normalizeCodeLanguage(lang);
  if (normalizedLang === "mermaid") return renderMermaidBlock(code);
  const langClass = normalizedLang ? ` language-${escapeAttribute(normalizedLang)}` : "";
  const langLabel = normalizedLang || "text";
  const lineCount = String(code).split("\n").length;
  const collapsible = lineCount > 24 || String(code).length > 3000;
  const path = detectCodePath(code);
  const vscodeButton = path
    ? `<button class="code-action" type="button" data-code-action="vscode" data-code-path="${escapeAttribute(path)}" aria-label="在 VS Code 中打开">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 7h10v10H7z" />
          <path d="M4 4h16v16H4z" />
        </svg>
        <span>VS Code</span>
      </button>`
    : "";
  return `
    <div class="code-card ${collapsible ? "collapsed" : ""}" data-code-lang="${escapeAttribute(langLabel)}">
      <textarea class="code-source" hidden>${escapeHtml(code)}</textarea>
      <div class="code-header">
        <span class="code-language">${escapeHtml(langLabel)}</span>
        <div class="code-actions">
          ${vscodeButton}
          ${
            collapsible
              ? `<button class="code-action" type="button" data-code-action="toggle-collapse" aria-label="折叠或展开代码">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m7 10 5 5 5-5" />
                  </svg>
                  <span>展开</span>
                </button>`
              : ""
          }
          <button class="code-action" type="button" data-code-action="copy" aria-label="复制代码">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>复制</span>
          </button>
          <button class="code-action" type="button" data-code-action="download" aria-label="下载代码">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            <span>下载</span>
          </button>
        </div>
      </div>
      <pre><code class="code-body${langClass}">${highlightCodeLines(code, normalizedLang)}</code></pre>
    </div>
  `;
}

function renderMermaidBlock(code) {
  const source = String(code || "");
  const fallback = renderSimpleMermaid(source) || escapeHtml(source);
  return `
    <div class="mermaid-card">
      <textarea class="code-source mermaid-source" hidden>${escapeHtml(source)}</textarea>
      <div class="code-header">
        <span class="code-language">mermaid</span>
        <div class="code-actions">
          <button class="code-action" type="button" data-code-action="copy" aria-label="复制 Mermaid 源码">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>复制</span>
          </button>
        </div>
      </div>
      <div class="mermaid-output" data-mermaid-source="${escapeAttribute(source)}">${fallback}</div>
    </div>
  `;
}

function renderSimpleMermaid(source) {
  const lines = String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  if (!/^(flowchart|graph)\s+/i.test(lines[0] || "")) return "";
  const nodes = new Map();
  const edges = [];
  const ensureNode = (token) => {
    const parsed = parseMermaidEndpoint(token);
    if (!parsed.id) return null;
    if (!nodes.has(parsed.id)) nodes.set(parsed.id, { id: parsed.id, label: parsed.label || parsed.id });
    else if (parsed.label) nodes.get(parsed.id).label = parsed.label;
    return parsed.id;
  };
  for (const line of lines.slice(1)) {
    const match = line.match(/^(.+?)\s*(-->|---|-.->)\s*(.+?)\s*;?$/);
    if (!match) {
      ensureNode(line);
      continue;
    }
    const from = ensureNode(match[1]);
    const to = ensureNode(match[3]);
    if (from && to) edges.push({ from, to });
  }
  const nodeList = Array.from(nodes.values()).slice(0, 18);
  if (!nodeList.length) return "";
  const positions = new Map();
  const width = 680;
  const height = Math.max(150, 72 * nodeList.length + 34);
  nodeList.forEach((node, index) => {
    positions.set(node.id, { x: index % 2 ? 392 : 108, y: 42 + index * 72 });
  });
  const edgeHtml = edges
    .filter((edge) => positions.has(edge.from) && positions.has(edge.to))
    .map((edge) => {
      const start = positions.get(edge.from);
      const end = positions.get(edge.to);
      return `<path d="M ${start.x + 90} ${start.y + 22} C ${start.x + 170} ${start.y + 22}, ${end.x - 80} ${end.y + 22}, ${end.x} ${end.y + 22}" class="mermaid-edge" marker-end="url(#arrow)"></path>`;
    })
    .join("");
  const nodeHtml = nodeList
    .map((node) => {
      const position = positions.get(node.id);
      const label = escapeHtml(node.label.length > 26 ? `${node.label.slice(0, 26)}...` : node.label);
      return `<g><rect x="${position.x}" y="${position.y}" width="180" height="44" rx="10" class="mermaid-node"></rect><text x="${position.x + 90}" y="${position.y + 27}" text-anchor="middle">${label}</text></g>`;
    })
    .join("");
  return `<svg class="mermaid-simple-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Mermaid flowchart"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" class="mermaid-arrow"></path></marker></defs>${edgeHtml}${nodeHtml}</svg>`;
}

function parseMermaidEndpoint(value) {
  const text = String(value || "").trim();
  const match = text.match(/^([A-Za-z0-9_:-]+)\s*(?:\[\s*"?([^"\]]+)"?\s*\]|\(\s*"?([^")]+)"?\s*\)|\{\s*"?([^"}]+)"?\s*\})?/);
  if (!match) return { id: "", label: "" };
  return { id: match[1], label: match[2] || match[3] || match[4] || match[1] };
}

export async function hydrateMermaidDiagrams(root = document) {
  if (!window.mermaid?.render) return;
  const nodes = root.querySelectorAll?.(".mermaid-output:not([data-rendered])") || [];
  let index = 0;
  for (const node of nodes) {
    const source = node.dataset.mermaidSource || node.textContent || "";
    try {
      window.mermaid.initialize?.({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      const result = await window.mermaid.render(`deepseek-mermaid-${Date.now()}-${index}`, source);
      node.innerHTML = result.svg || "";
      node.dataset.rendered = "1";
    } catch {
      node.dataset.rendered = "error";
    }
    index += 1;
  }
}

export function normalizeCodeLanguage(value) {
  const lang = String(value || "").trim().toLowerCase();
  const aliases = {
    "c++": "cpp",
    "c#": "csharp",
    shell: "bash",
    sh: "bash",
    js: "javascript",
    ts: "typescript",
    py: "python",
  };
  return aliases[lang] || lang;
}

function highlightCode(code, lang) {
  const language = normalizeCodeLanguage(lang);
  const highlightedLanguages = new Set([
    "bash",
    "c",
    "cpp",
    "csharp",
    "css",
    "go",
    "html",
    "java",
    "javascript",
    "json",
    "python",
    "sql",
    "typescript",
  ]);
  if (!highlightedLanguages.has(language)) return escapeHtml(code);

  const keywords = new Set([
    "and",
    "as",
    "async",
    "await",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "def",
    "default",
    "delete",
    "do",
    "double",
    "else",
    "enum",
    "except",
    "false",
    "finally",
    "float",
    "for",
    "from",
    "function",
    "if",
    "import",
    "in",
    "int",
    "interface",
    "let",
    "long",
    "new",
    "null",
    "or",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "sizeof",
    "static",
    "struct",
    "switch",
    "throw",
    "true",
    "try",
    "typedef",
    "undefined",
    "var",
    "void",
    "while",
  ]);
  const source = String(code);
  const tokenPattern =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[uUlLfF]+)?\b|\b[A-Za-z_]\w*\b|[-+*/%=!<>:&|^~]+/gm;
  let html = "";
  let lastIndex = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    html += escapeHtml(source.slice(lastIndex, match.index));
    html += renderCodeToken(token, source.slice(match.index + token.length), keywords, language);
    lastIndex = match.index + token.length;
  }
  html += escapeHtml(source.slice(lastIndex));
  return html;
}

function highlightCodeLines(code, lang) {
  const lines = String(code).split("\n");
  return lines
    .map((line, index) => {
      const content = line ? highlightCode(line, lang) : "\u200b";
      return `<span class="code-line"><span class="code-line-number" aria-hidden="true">${index + 1}</span><span class="code-line-content">${content}</span></span>`;
    })
    .join("");
}

function detectCodePath(code) {
  const lines = String(code || "").split("\n").slice(0, 4);
  for (const line of lines) {
    const match = line.match(/(?:file|path|文件)\s*[:=]\s*([A-Za-z]:[\\/][^\s"'`]+|\/[^\s"'`]+)/i);
    if (match) return match[1];
  }
  return "";
}

function hasChartableTable(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  return rows.slice(1).some((row) => row.slice(1).some((cell) => Number.isFinite(parseChartNumber(cell))));
}

function parseChartNumber(value) {
  const cleaned = String(value || "").replace(/[%,$，\s]/g, "");
  if (!cleaned) return NaN;
  return Number(cleaned);
}

function renderCodeToken(token, rest, keywords, language) {
  let className = "";
  if (token.startsWith("//") || token.startsWith("/*")) className = "code-token-comment";
  else if (token.startsWith("#")) {
    className = ["bash", "python"].includes(language) ? "code-token-comment" : "code-token-macro";
  }
  else if (/^["'`]/.test(token)) className = "code-token-string";
  else if (/^(?:0x[\da-fA-F]+|\d)/.test(token)) className = "code-token-number";
  else if (keywords.has(token)) className = "code-token-keyword";
  else if (/^[A-Za-z_]\w*$/.test(token) && /^\s*\(/.test(rest)) className = "code-token-function";
  else if (/^[-+*/%=!<>:&|^~]+$/.test(token)) className = "code-token-operator";
  return className ? `<span class="${className}">${escapeHtml(token)}</span>` : escapeHtml(token);
}

function parseTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!trimmed.includes("|")) return [];
  return trimmed.split("|");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function generatedDownloadIdFromHref(href) {
  const raw = String(href || "").replaceAll("&amp;", "&");
  try {
    const parsed = new URL(raw, "http://127.0.0.1");
    if (parsed.pathname !== "/api/download") return "";
    const id = parsed.searchParams.get("id") || "";
    return /^[0-9a-f]{32}$/i.test(id) ? id : "";
  } catch {
    const match = raw.match(/(?:^|\/)api\/download\?[^#\s]*\bid=([0-9a-f]{32})(?:[&#\s]|$)/i);
    return match ? match[1] : "";
  }
}

