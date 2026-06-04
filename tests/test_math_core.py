from __future__ import annotations

import subprocess
import textwrap
import unittest


def run_math_core(script: str, *, with_katex: bool = True) -> None:
    katex_setup = "const katex = require('./static/vendor/katex/katex.min.js');\n" if with_katex else ""
    context_setup = "const context = { console, katex };\n" if with_katex else "const context = { console };\n"
    code = (
        "const fs = require('fs');\n"
        "const vm = require('vm');\n"
        "const assert = require('assert');\n"
        f"{katex_setup}"
        f"{context_setup}"
        "context.globalThis = context;\n"
        "vm.createContext(context);\n"
        "vm.runInContext(fs.readFileSync('static/math_core.js', 'utf8'), context);\n"
        "const M = context.DeepSeekMathCore;\n"
        + textwrap.dedent(script)
    )
    subprocess.run(["node", "-e", code], check=True)


def run_markdown_renderer(script: str) -> None:
    code = (
        "const assert = require('assert');\n"
        "const { pathToFileURL } = require('url');\n"
        "globalThis.window = globalThis;\n"
        "globalThis.DeepSeekMathCore = {\n"
        "  extractInlineMath(value) { return [{ type: 'text', value: String(value || '') }]; },\n"
        "  renderMathExpression(value, display) {\n"
        "    const source = String(value || '');\n"
        "    if (source.trim() === '\\\\frac{a}') return '<span class=\"math-error\">Unexpected end of input</span>';\n"
        "    return `<span class=\"${display ? 'katex-display' : 'katex'}\">${source}</span>`;\n"
        "  },\n"
        "};\n"
        "(async () => {\n"
        "  const moduleUrl = pathToFileURL('static/modules/markdown.js').href + `?test=${Date.now()}`;\n"
        "  const markdown = await import(moduleUrl);\n"
        "  const context = { console, assert, ...markdown };\n"
        + textwrap.dedent(script)
        + "\n})().catch((error) => { console.error(error); process.exit(1); });\n"
    )
    subprocess.run(["node", "-e", code], check=True)


class MathCoreTests(unittest.TestCase):
    def test_render_fraction_sqrt_superscript_and_subscript_with_katex(self) -> None:
        run_math_core(
            r"""
            const html = M.renderMathExpression(String.raw`\frac{x_1^2}{\sqrt{a+b}}`, true);
            assert.ok(html.includes('katex-display'));
            assert.ok(html.includes('class="katex"'));
            assert.ok(html.includes('data-latex="\\frac{x_1^2}{\\sqrt{a+b}}"'));
            assert.ok(html.includes('mfrac'));
            assert.ok(html.includes('sqrt'));
            assert.ok(html.includes('msupsub'));
            assert.strictEqual(M.katexVersion(), katex.version);
            """
        )

    def test_inline_math_extraction_supports_common_delimiters(self) -> None:
        run_math_core(
            r"""
            const parts = M.extractInlineMath(String.raw`价 \(x_1^2\) 与 $E=mc^2$。`);
            assert.strictEqual(JSON.stringify(parts.map((part) => part.type)), JSON.stringify(['text', 'math', 'text', 'math', 'text']));
            assert.strictEqual(parts[1].value, 'x_1^2');
            assert.strictEqual(parts[3].value, 'E=mc^2');
            """
        )

    def test_inline_math_extraction_does_not_treat_plain_currency_as_formula(self) -> None:
        run_math_core(
            r"""
            const parts = M.extractInlineMath('价格是 $5$，不是公式；但 $x_1$ 是。');
            assert.strictEqual(parts.filter((part) => part.type === 'math').length, 1);
            assert.strictEqual(parts.find((part) => part.type === 'math').value, 'x_1');
            """
        )

    def test_math_renderer_escapes_html_inside_formula(self) -> None:
        run_math_core(
            r"""
            const html = M.renderMathExpression(String.raw`x < y \text{<script>}`, false);
            assert.ok(!html.includes('<script>'));
            assert.ok(html.includes('&lt;'));
            assert.ok(html.includes('katex'));
            """
        )

    def test_maximum_likelihood_formula_commands_are_rendered(self) -> None:
        run_math_core(
            r"""
            const source = String.raw`\ell(\theta)=\ln L(\theta)=\sum_{i=1}^n \ln f(x_i \mid \theta)`;
            const html = M.renderMathExpression(source, true);
            assert.ok(html.includes('ℓ'));
            assert.ok(html.includes('θ'));
            assert.ok(html.includes('∑'));
            assert.ok(html.includes('mop'));
            assert.ok(html.includes('mrel'));
            assert.ok(!html.includes('>\\ell<'));
            assert.ok(!html.includes('>\\mid<'));
            assert.ok(!html.includes('math-error'));
            """
        )

    def test_derivative_and_hat_commands_are_rendered(self) -> None:
        run_math_core(
            r"""
            const derivative = M.renderMathExpression(String.raw`\frac{\partial \ell(\theta)}{\partial \theta}=0`, true);
            const hat = M.renderMathExpression(String.raw`\hat\theta=\hat{\theta}`, false);
            assert.ok(derivative.includes('∂'));
            assert.ok(derivative.includes('ℓ'));
            assert.ok(derivative.includes('mfrac'));
            assert.ok(hat.includes('accent'));
            assert.ok(!derivative.includes('math-error'));
            assert.ok(!hat.includes('math-error'));
            """
        )

    def test_second_derivative_maximum_check_does_not_leak_size_commands(self) -> None:
        run_math_core(
            r"""
            const source = String.raw`\frac{\partial^2 \ell(\theta)}{\partial \theta^2}\bigg|_{\theta=\hat\theta}<0`;
            const html = M.renderMathExpression(source, true);
            const renderedHtml = html.replace(/\sdata-latex="[^"]*"/g, "");
            assert.ok(html.includes('ℓ'));
            assert.ok(html.includes('∂'));
            assert.ok(html.includes('accent'));
            assert.ok(!renderedHtml.includes('\\bigg'));
            assert.ok(!html.includes('math-error'));
            """
        )

    def test_normal_likelihood_formula_uses_katex_layout(self) -> None:
        run_math_core(
            r"""
            const source = String.raw`L(\mu)=\prod_{i=1}^n \frac{1}{\sqrt{2\pi\sigma^2}}\exp\left(-\frac{(x_i-\mu)^2}{2\sigma^2}\right)`;
            const html = M.renderMathExpression(source, true);
            assert.ok(html.includes('katex-display'));
            assert.ok(html.includes('∏'));
            assert.ok(html.includes('sqrt'));
            assert.ok(html.includes('mfrac'));
            assert.ok(html.includes('mop'));
            assert.ok(!html.includes('math-frac'));
            assert.ok(!html.includes('math-sqrt'));
            """
        )

    def test_katex_supports_matrix_and_cases_environments(self) -> None:
        run_math_core(
            r"""
            const matrix = M.renderMathExpression(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, true);
            const cases = M.renderMathExpression(String.raw`\begin{cases}x^2,&x>0\\0,&x\le0\end{cases}`, true);
            assert.ok(matrix.includes('mtable'));
            assert.ok(matrix.includes('arraycolsep'));
            assert.ok(cases.includes('mtable'));
            assert.ok(cases.includes('delimsizing'));
            assert.ok(!matrix.includes('math-error'));
            assert.ok(!cases.includes('math-error'));
            """
        )

    def test_pending_fallback_when_katex_is_not_loaded(self) -> None:
        run_math_core(
            r"""
            const html = M.renderMathExpression(String.raw`\frac{a}{b}`, true);
            assert.ok(html.includes('math-pending'));
            assert.ok(html.includes('data-display="1"'));
            assert.ok(html.includes('data-latex="\\frac{a}{b}"'));
            assert.ok(html.includes('\\frac{a}{b}'));
            assert.strictEqual(M.katexVersion(), '');
            """,
            with_katex=False,
        )

    def test_unclosed_block_math_during_streaming_is_kept_as_text(self) -> None:
        run_markdown_renderer(
            r"""
            const partial = context.formatContent(String.raw`$$
\frac{a}`, { streaming: true });
            assert.ok(!partial.includes('math-error'));
            assert.ok(partial.includes('$$'));
            assert.ok(partial.includes('\\frac{a}'));

            const final = context.formatContent(String.raw`$$
\frac{a}`);
            assert.ok(final.includes('math-error'));

            const closed = context.formatContent(String.raw`$$
\frac{a}{b}
$$`, { streaming: true });
            assert.ok(closed.includes('math-block-wrap'));
            assert.ok(closed.includes('katex-display'));
            assert.ok(!closed.includes('math-error'));
            """
        )

    def test_unclosed_code_fence_during_streaming_is_kept_as_text(self) -> None:
        run_markdown_renderer(
            r"""
            const partial = context.formatContent("```js\nconsole.log(\"streaming\")", { streaming: true });
            assert.ok(!partial.includes('code-card'));
            assert.ok(partial.includes('```js'));
            assert.ok(partial.includes('console.log'));

            const final = context.formatContent("```js\nconsole.log(\"final\")", { streaming: false });
            assert.ok(final.includes('code-card'));
            assert.ok(final.includes('console.log'));
            """
        )

    def test_local_download_links_render_as_clickable_anchors(self) -> None:
        run_markdown_renderer(
            r"""
            const html = context.formatContent("[点击下载 PPT](/api/download?id=96c1bd73a3f9e6d462808416d0ae3e56)");
            assert.ok(html.includes('<a href="/api/download?id=96c1bd73a3f9e6d462808416d0ae3e56"'));
            assert.ok(html.includes('class="download-link"'));
            assert.ok(html.includes('data-download-id="96c1bd73a3f9e6d462808416d0ae3e56"'));
            assert.ok(html.includes('download>点击下载 PPT</a>'));
            assert.ok(!html.includes('[/api/download'));
            """
        )

    def test_absolute_download_links_render_as_local_download_anchors(self) -> None:
        run_markdown_renderer(
            r"""
            const html = context.formatContent("[下载](https://chat.deepseek.com/api/download?id=96c1bd73a3f9e6d462808416d0ae3e56)");
            assert.ok(html.includes('<a href="/api/download?id=96c1bd73a3f9e6d462808416d0ae3e56"'));
            assert.ok(html.includes('class="download-link"'));
            assert.ok(html.includes('data-download-id="96c1bd73a3f9e6d462808416d0ae3e56"'));
            assert.ok(!html.includes('chat.deepseek.com/api/download'));
            """
        )

    def test_generated_download_images_render_inline(self) -> None:
        run_markdown_renderer(
            r"""
            const html = context.formatContent("![Launch.svg](/api/download?id=96c1bd73a3f9e6d462808416d0ae3e56)");
            assert.ok(html.includes('class="generated-image generated-mindmap"'));
            assert.ok(html.includes('<img src="/api/download?id=96c1bd73a3f9e6d462808416d0ae3e56&inline=1"'));
            assert.ok(html.includes('alt="Launch.svg"'));
            assert.ok(html.includes('class="download-link"'));
            assert.ok(html.includes('data-download-id="96c1bd73a3f9e6d462808416d0ae3e56"'));
            assert.ok(!html.includes('!<a'));
            """
        )


if __name__ == "__main__":
    unittest.main()
