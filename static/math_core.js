(function attachMathCore(global) {
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeMathSource(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/^\s+|\s+$/g, "");
  }

  function katexOptions(display) {
    return {
      displayMode: Boolean(display),
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html",
    };
  }

  function renderPendingMath(source, display) {
    return [
      `<span class="math-pending" data-math="${escapeHtml(source)}" data-latex="${escapeHtml(source)}" data-display="${display ? "1" : "0"}">`,
      escapeHtml(source),
      "</span>",
    ].join("");
  }

  function annotateRenderedMath(html, source) {
    return String(html).replace(/<span class="(katex(?:-display)?)([^"]*)"/, `<span data-latex="${escapeHtml(source)}" class="$1$2"`);
  }

  function renderMathExpression(value, display = false) {
    const source = normalizeMathSource(value);
    const renderer = global.katex;
    if (!renderer || typeof renderer.renderToString !== "function") {
      return renderPendingMath(source, display);
    }

    try {
      return annotateRenderedMath(renderer.renderToString(source, katexOptions(display)), source);
    } catch (err) {
      return `<span class="math-error" data-latex="${escapeHtml(source)}" title="${escapeHtml(String(err))}">${escapeHtml(source)}</span>`;
    }
  }

  function renderPendingMathIn(root = global.document) {
    const renderer = global.katex;
    if (!root || !renderer || typeof renderer.renderToString !== "function" || typeof root.querySelectorAll !== "function") {
      return;
    }

    for (const element of root.querySelectorAll(".math-pending")) {
      const tex = element.dataset.math || "";
      const display = element.dataset.display === "1";
      element.outerHTML = renderMathExpression(tex, display);
    }
  }

  function extractInlineMath(value) {
    const source = String(value || "");
    const segments = [];
    let index = 0;
    while (index < source.length) {
      const slashOpen = findUnescaped(source, "\\(", index);
      const dollarOpen = findNextDollar(source, index);
      const nextOpen = minPositive(slashOpen, dollarOpen);
      if (nextOpen < 0) break;

      if (nextOpen > index) {
        segments.push({ type: "text", value: source.slice(index, nextOpen) });
      }

      if (slashOpen === nextOpen) {
        const close = findUnescaped(source, "\\)", nextOpen + 2);
        if (close < 0) {
          segments.push({ type: "text", value: source.slice(nextOpen) });
          index = source.length;
          break;
        }
        segments.push({ type: "math", value: source.slice(nextOpen + 2, close), display: false });
        index = close + 2;
        continue;
      }

      const close = findMathDollarClose(source, nextOpen + 1);
      if (close < 0) {
        segments.push({ type: "text", value: source.slice(nextOpen) });
        index = source.length;
        break;
      }
      const candidate = source.slice(nextOpen + 1, close);
      if (!isLikelyInlineMath(candidate)) {
        segments.push({ type: "text", value: source.slice(nextOpen, close + 1) });
        index = close + 1;
        continue;
      }
      segments.push({ type: "math", value: candidate, display: false });
      index = close + 1;
    }
    if (index < source.length) {
      segments.push({ type: "text", value: source.slice(index) });
    }
    return segments;
  }

  function findUnescaped(source, needle, start) {
    let index = source.indexOf(needle, start);
    while (index >= 0 && isEscaped(source, index)) {
      index = source.indexOf(needle, index + needle.length);
    }
    return index;
  }

  function findNextDollar(source, start) {
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "$" && source[index + 1] !== "$" && !isEscaped(source, index)) {
        return index;
      }
    }
    return -1;
  }

  function findMathDollarClose(source, start) {
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "$" && source[index + 1] !== "$" && !isEscaped(source, index)) {
        return index;
      }
    }
    return -1;
  }

  function isEscaped(source, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      count += 1;
    }
    return count % 2 === 1;
  }

  function minPositive(...values) {
    const positive = values.filter((value) => value >= 0);
    return positive.length ? Math.min(...positive) : -1;
  }

  function isLikelyInlineMath(value) {
    const text = String(value || "").trim();
    if (!text || text.includes("\n")) return false;
    if (/^\d+(?:[.,]\d+)?$/.test(text)) return false;
    if (/\\[A-Za-z]+|[\^_={}|<>]|[A-Za-z]\s*[+\-*/]\s*[A-Za-z0-9]|[A-Za-z]\d|\d[A-Za-z]/.test(text)) return true;
    if (/^[A-Za-z]$/.test(text)) return true;
    return false;
  }

  global.DeepSeekMathCore = Object.freeze({
    extractInlineMath,
    isLikelyInlineMath,
    katexVersion: () => global.katex?.version || "",
    renderMathExpression,
    renderPendingMathIn,
  });
})(globalThis);
