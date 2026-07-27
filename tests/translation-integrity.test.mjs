import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const { runTranslationIntegrityPass } = loadTsModule("src/lib/translation-integrity.ts");
const { normalizeTranslationTypography } = loadTsModule("src/lib/translation-postprocess.ts");
const { protectMarkdownFragments } = loadTsModule("src/lib/markdown-table-utils.ts");

function issueKinds(result) {
  return [...result.issues].map((issue) => issue.kind);
}

test("clean translations pass through unchanged and without issues", () => {
  const result = runTranslationIntegrityPass({
    text: "This is a translated paragraph.",
    targetLang: "English",
    preservedFragments: [],
  });

  assert.equal(result.text, "This is a translated paragraph.");
  assert.equal(result.changed, false);
  assert.equal(result.issues.length, 0);
});

test("intact markers are restored without being reported as damaged", () => {
  const { text, fragments } = protectMarkdownFragments("before `code` after");
  const result = runTranslationIntegrityPass({
    text,
    targetLang: "English",
    preservedFragments: fragments,
  });

  assert.equal(result.text, "before `code` after");
  assert.equal(issueKinds(result).includes("placeholder-repaired"), false);
});

test("markers renamed by the model are recovered by their numeric index", () => {
  const fragments = [
    { marker: "@@DOTI_MATH_BLOCK_0001@@", content: "$$\nE = mc^2\n$$", kind: "math-block" },
  ];
  const result = runTranslationIntegrityPass({
    text: "公式：@@DOTI_FORMULA_0001@@ 结束",
    targetLang: "Chinese",
    preservedFragments: fragments,
  });

  assert.ok(result.text.includes("E = mc^2"), "the protected content should be recovered");
  assert.ok(issueKinds(result).includes("placeholder-repaired"));
  assert.equal(result.changed, true);
});

test("placeholders that cannot be recovered are reported as unresolved", () => {
  const result = runTranslationIntegrityPass({
    text: "残留 @@DOTI_MATH_BLOCK_0007@@ 占位符",
    targetLang: "Chinese",
    preservedFragments: [],
  });

  assert.ok(issueKinds(result).includes("placeholder-unresolved"));
});

test("html tables escaped by the model are decoded and spaced as blocks", () => {
  const result = runTranslationIntegrityPass({
    text: "文本&lt;table&gt;&lt;tr&gt;&lt;td&gt;甲&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;尾部",
    targetLang: "Chinese",
    preservedFragments: [],
  });

  assert.ok(result.text.includes("<table>"), "escaped entities should be decoded back to html");
  assert.ok(result.text.includes("\n\n<table>"), "tables need a blank line before them");
  assert.ok(result.text.includes("</table>\n\n"), "tables need a blank line after them");
  assert.ok(issueKinds(result).includes("escaped-html-table"));
  assert.ok(issueKinds(result).includes("html-table-spacing"));
});

test("dangling html tables are closed and reported", () => {
  const result = runTranslationIntegrityPass({
    text: "<table><tr><td>cell\n\n# 下一节",
    targetLang: "Chinese",
    preservedFragments: [],
  });

  assert.ok(result.text.includes("</table>"));
  assert.ok(issueKinds(result).includes("html-table-closed"));
});

test("loose single-dollar display math is normalized back to $$ fences", () => {
  const result = runTranslationIntegrityPass({
    text: "前文\n\n$\nx = y + 1\n$\n\n后文",
    targetLang: "English",
    preservedFragments: [],
  });

  assert.ok(result.text.includes("$$\nx = y + 1\n$$"));
  assert.ok(issueKinds(result).includes("display-math-normalized"));
});

test("chinese typography normalization strips spacing artifacts only for chinese targets", () => {
  const spaced = "这是 一段 译文 ，很好";

  assert.equal(normalizeTranslationTypography(spaced, "Chinese"), "这是一段译文，很好");
  assert.equal(normalizeTranslationTypography(spaced, "zh"), "这是一段译文，很好");
  assert.equal(normalizeTranslationTypography(spaced, "English"), spaced);
});

test("chinese typography normalization keeps latin words separated", () => {
  assert.equal(
    normalizeTranslationTypography("使用 Transformer 模型", "chinese"),
    "使用 Transformer 模型"
  );
});

test("the integrity pass applies target-language typography", () => {
  const result = runTranslationIntegrityPass({
    text: "这是 一段 译文",
    targetLang: "Chinese",
    preservedFragments: [],
  });

  assert.equal(result.text, "这是一段译文");
  assert.equal(result.changed, true);
});
