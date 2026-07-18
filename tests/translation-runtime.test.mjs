import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath) {
  const filename = path.resolve(relativePath);
  const source = fs.readFileSync(filename, "utf-8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      return require(path.resolve(dirname, specifier));
    }
    return require(specifier);
  };

  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require: localRequire,
  }, { filename });

  return module.exports;
}

const {
  buildMarkdownFromTranslationBlocks,
  createSingleTranslationBlock,
  normalizeTranslationBlockText,
} = loadTsModule("src/lib/translation-runtime.ts");

test("normalizes translation block boundaries without changing internal paragraphs", () => {
  assert.equal(
    normalizeTranslationBlockText("\r\n\n  第一段  \n\n\n第二段\n\n"),
    "第一段\n\n第二段"
  );
});

test("joins translation blocks with one stable markdown paragraph break", () => {
  const markdown = buildMarkdownFromTranslationBlocks([
    { id: "b", index: 1, title: "B", kind: "text", state: "completed", text: "\n\n第二块\n\n" },
    { id: "a", index: 0, title: "A", kind: "text", state: "completed", text: "第一块\n\n\n" },
  ]);

  assert.equal(markdown, "第一块\n\n第二块");
});

test("single recovered translation blocks are stored normalized", () => {
  assert.deepEqual(createSingleTranslationBlock("\n\n译文\n\n")[0]?.text, "译文");
});
