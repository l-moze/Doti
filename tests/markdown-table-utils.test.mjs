import assert from "node:assert/strict";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const {
  PreservedMarkdownStreamRestorer,
  applySoftGlossaryCorrections,
  protectLockedGlossaryTerms,
  protectMarkdownFragments,
  repairDanglingHtmlTables,
  restorePreservedMarkdownFragments,
} = loadTsModule("src/lib/markdown-table-utils.ts");

function roundTrip(markdown, options) {
  const { text, fragments } = options
    ? protectMarkdownFragments(markdown, options)
    : protectMarkdownFragments(markdown);
  return { text, fragments, restored: restorePreservedMarkdownFragments(text, fragments) };
}

test("plain prose without protectable syntax is returned untouched", () => {
  const markdown = "A paragraph with no math, code or tables.";
  const { text, fragments } = protectMarkdownFragments(markdown);

  assert.equal(text, markdown);
  assert.equal(fragments.length, 0);
});

test("fenced code blocks are protected as single fragments and restored verbatim", () => {
  const markdown = ["Intro", "```python", "def f(x):", "    return x | 2", "```", "Outro"].join("\n");
  const { text, fragments, restored } = roundTrip(markdown);

  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].kind, "code-block");
  assert.equal(fragments[0].content, "```python\ndef f(x):\n    return x | 2\n```");
  assert.equal(text.includes("def f(x):"), false, "code body should be hidden behind a marker");
  assert.equal(restored, markdown);
});

test("html tables, markdown pipe tables and display math survive a protect/restore round trip", () => {
  const markdown = [
    "<table><tr><td>a</td></tr></table>",
    "",
    "| head | second |",
    "| --- | --- |",
    "| one | two |",
    "",
    "$$",
    "x = y + 1",
    "$$",
  ].join("\n");
  const { fragments, restored } = roundTrip(markdown);
  const kinds = fragments.map((fragment) => fragment.kind);

  assert.ok(kinds.includes("html-table"));
  assert.ok(kinds.includes("markdown-table"));
  assert.ok(kinds.includes("math-block"));
  assert.equal(restored, markdown);
});

test("markers are unique, indexed and structurally stable", () => {
  const { fragments } = protectMarkdownFragments("`a` and `b` and `c`");

  assert.equal(fragments.length, 3);
  assert.deepEqual(
    [...fragments].map((fragment) => fragment.marker),
    ["@@DOTI_CODE_INLINE_0001@@", "@@DOTI_CODE_INLINE_0002@@", "@@DOTI_CODE_INLINE_0003@@"]
  );
});

test("inline math protection can be disabled while block syntax stays protected", () => {
  const markdown = "Inline $x_1$ next to a block:\n\n$$\ny = 2\n$$";
  const withInline = protectMarkdownFragments(markdown);
  const withoutInline = protectMarkdownFragments(markdown, { preserveInlineMath: false });

  assert.ok(withInline.fragments.some((fragment) => fragment.kind === "math-inline"));
  assert.equal(withoutInline.fragments.some((fragment) => fragment.kind === "math-inline"), false);
  assert.ok(withoutInline.text.includes("$x_1$"), "inline math should stay translatable when opted out");
  assert.ok(withoutInline.fragments.some((fragment) => fragment.kind === "math-block"));
});

test("prices and plain words between dollar signs are not treated as inline math", () => {
  const { fragments, restored } = roundTrip("It costs $12.50 today and $30 tomorrow.");

  assert.equal(fragments.length, 0);
  assert.equal(restored, "It costs $12.50 today and $30 tomorrow.");
});

test("restoring tolerates markers mangled by a translation model", () => {
  const { fragments } = protectMarkdownFragments("before `code` after");
  const mangled = "之前 @@ DOTI_CODE_INLINE_0001 @@ 之后";

  assert.equal(restorePreservedMarkdownFragments(mangled, fragments), "之前 `code` 之后");
});

test("restoring is a no-op when no fragments were protected", () => {
  assert.equal(restorePreservedMarkdownFragments("unchanged", []), "unchanged");
});

test("locked glossary terms are protected while ordinary words are left translatable", () => {
  const { text, fragments } = protectLockedGlossaryTerms("The GPU runs the model quickly.", [
    { source: "GPU", target: "GPU" },
    { source: "model", target: "模型" },
  ]);

  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].kind, "glossary-term");
  assert.equal(fragments[0].content, "GPU");
  assert.ok(text.includes("model"), "lowercase common words should not be locked");
  assert.equal(restorePreservedMarkdownFragments(text, fragments), "The GPU runs the model quickly.");
});

test("glossary protection keeps the target spelling of a locked term", () => {
  const { text, fragments } = protectLockedGlossaryTerms("Use CUDA here.", [
    { source: "CUDA", target: "CUDA 平台" },
  ]);

  assert.equal(restorePreservedMarkdownFragments(text, fragments), "Use CUDA 平台 here.");
});

test("glossary protection skips empty term lists and existing doti markers", () => {
  const withoutTerms = protectLockedGlossaryTerms("text", []);
  assert.equal(withoutTerms.text, "text");
  assert.equal(withoutTerms.fragments.length, 0);

  const { fragments } = protectLockedGlossaryTerms("@@DOTI_CODE_INLINE_0001@@ GPU", [
    { source: "CODE", target: "CODE" },
  ]);
  assert.equal(fragments.length, 0);
});

test("soft glossary corrections rewrite whole words only", () => {
  const corrected = applySoftGlossaryCorrections("transformer and transformers", [
    { source: "transformer", target: "变换器" },
  ]);

  assert.equal(corrected, "变换器 and transformers");
});

test("soft glossary corrections prefer the longest matching term", () => {
  const corrected = applySoftGlossaryCorrections("a large language model here", [
    { source: "language model", target: "语言模型" },
    { source: "model", target: "模型" },
  ]);

  assert.equal(corrected, "a large 语言模型 here");
});

test("dangling html tables are closed at the next block boundary", () => {
  const repaired = repairDanglingHtmlTables("<table><tr><td>cell\n\n# Next section");

  assert.ok(repaired.includes("</td></tr></table>"), "open tags should be closed before the heading");
  assert.ok(repaired.indexOf("</table>") < repaired.indexOf("# Next section"));
});

test("dangling html tables are closed at the end of the document", () => {
  const repaired = repairDanglingHtmlTables("<table><tr><th>head");

  assert.equal(repaired.trimEnd().endsWith("</th></tr></table>"), true);
});

test("well formed markdown is not modified by the html table repair pass", () => {
  const markdown = "<table>\n<tr><td>a</td></tr>\n</table>\n\ntext";

  assert.equal(repairDanglingHtmlTables(markdown), markdown);
  assert.equal(repairDanglingHtmlTables("no tables here"), "no tables here");
});

test("stream restorer holds back partial markers until they can be resolved", () => {
  const { text, fragments } = protectMarkdownFragments("start `code` end");
  const restorer = new PreservedMarkdownStreamRestorer(fragments);
  const markerStart = text.indexOf("@@");
  const head = text.slice(0, markerStart + 6);
  const tail = text.slice(markerStart + 6);

  const firstEmit = restorer.consume(head);
  assert.equal(firstEmit.includes("DOTI_"), false, "a partial marker must never be emitted");

  const secondEmit = restorer.consume(tail, true);
  assert.equal(firstEmit + secondEmit, "start `code` end");
});

test("stream restorer passes text straight through when nothing was protected", () => {
  const restorer = new PreservedMarkdownStreamRestorer([]);

  assert.equal(restorer.consume("plain "), "plain ");
  assert.equal(restorer.consume("stream", true), "stream");
});
