import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath, contextOverrides = {}) {
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
    AbortSignal,
    ArrayBuffer,
    Blob,
    Buffer,
    Response,
    Uint8Array,
    console,
    exports: module.exports,
    module,
    process,
    require: localRequire,
    ...contextOverrides,
  }, { filename });

  return module.exports;
}

test("uploads only the visible bytes from Buffer views", async () => {
  let uploadedBody = null;
  const { MinerUClient } = loadTsModule("src/lib/mineru-client.ts", {
    fetch: async (_url, init) => {
      uploadedBody = init.body;
      return new Response(null, { status: 200 });
    },
  });

  const client = new MinerUClient({ apiKey: "test-key" });
  const backingBuffer = Buffer.from("__PDF-DATA__");
  const pdfSlice = backingBuffer.subarray(2, 10);

  await client.uploadFileToUrl("https://example.test/upload", pdfSlice);

  assert.ok(uploadedBody instanceof Uint8Array);
  assert.equal(Buffer.from(uploadedBody).toString("utf-8"), "PDF-DATA");
});
