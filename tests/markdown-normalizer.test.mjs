import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const { normalizeMarkdownMathForDisplay } = loadTsModule("src/lib/markdown-normalizer.ts");

test("text without latex markers is returned untouched", () => {
  const markdown = "A plain paragraph.\n\nAnother one.";

  assert.equal(normalizeMarkdownMathForDisplay(markdown), markdown);
});

test("single dollar fences are promoted to display math fences", () => {
  const normalized = normalizeMarkdownMathForDisplay("前文\n$\nx = y + 1\n$\n后文");

  assert.ok(normalized.includes("$$\nx = y + 1\n$$"));
  assert.equal(normalized.includes("\n$\n"), false, "loose single dollar fences should be gone");
});

test("display math environments are wrapped in $$ fences", () => {
  const normalized = normalizeMarkdownMathForDisplay("intro\n\\begin{aligned}\na &= b\n\\end{aligned}\ntail");

  assert.ok(normalized.includes("$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$"));
});

test("already wrapped environments are not double wrapped", () => {
  const markdown = "$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$";

  assert.equal(normalizeMarkdownMathForDisplay(markdown), markdown);
});

test("inline environments that are not display math are left alone", () => {
  const markdown = "\\begin{itemize}\n\\item one\n\\end{itemize}";

  assert.equal(normalizeMarkdownMathForDisplay(markdown), markdown);
});

test("unterminated environments are left as-is instead of swallowing the rest", () => {
  const markdown = "\\begin{aligned}\na &= b\n\nplain tail";

  assert.equal(normalizeMarkdownMathForDisplay(markdown), markdown);
});

test("bare latex lines are wrapped as display math blocks", () => {
  const normalized = normalizeMarkdownMathForDisplay("Result:\n\\frac{\\partial L}{\\partial w} = 0\nDone.");

  assert.ok(normalized.includes("$$\n\\frac{\\partial L}{\\partial w} = 0\n$$"));
});

test("prose, headings and table rows are never mistaken for bare latex", () => {
  for (const markdown of [
    "The model uses a \\textit{soft} margin. It works well.",
    "## Section with $ sign",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "中文段落里出现 \\alpha = 1 的说明",
  ]) {
    assert.equal(normalizeMarkdownMathForDisplay(markdown), markdown, markdown);
  }
});

test("normalization is idempotent and cached across repeated calls", () => {
  const markdown = "Result:\n\\frac{\\partial L}{\\partial w} = 0\nDone.";
  const once = normalizeMarkdownMathForDisplay(markdown);

  assert.equal(normalizeMarkdownMathForDisplay(markdown), once);
  assert.equal(normalizeMarkdownMathForDisplay(once), once);
});

test("wrapping never leaves more than one blank line between blocks", () => {
  const normalized = normalizeMarkdownMathForDisplay("intro\n\n\n\\begin{equation}\nx = 1\n\\end{equation}\n\n\ntail");

  assert.equal(/\n{3,}/.test(normalized), false);
});
