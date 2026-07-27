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
      target: ts.ScriptTarget.ES2020,
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
    process,
    console,
    URL,
    Buffer,
  }, { filename });

  return module.exports;
}

const { assertSafeFileHash, isSafeFileHash, resolveUploadDir } = loadTsModule("src/lib/server/runtime-paths.ts");
const { assertAllowedOutboundUrl, isPrivateNetworkHostname } = loadTsModule("src/lib/server/outbound-url-guard.ts");

test("rejects file hashes that can escape the storage root", () => {
  assert.equal(isSafeFileHash("a".repeat(64)), true);
  assert.equal(isSafeFileHash("legacy_hash-1.v2"), true);

  for (const value of ["", " ", "..", ".", "../etc", "a/b", "a\\b", "a\0b", "a".repeat(129)]) {
    assert.equal(isSafeFileHash(value), false, `expected ${JSON.stringify(value)} to be rejected`);
  }

  assert.throws(() => assertSafeFileHash("../../etc/passwd"), /Invalid file hash/);
});

test("resolveUploadDir rejects traversal hashes", () => {
  const cwd = path.resolve("/tmp/doti-test");
  const env = { DESKTOP_UPLOADS_ROOT: "/tmp/doti-test/uploads" };

  assert.equal(
    resolveUploadDir("abc123", env, cwd),
    path.resolve("/tmp/doti-test/uploads/abc123")
  );
  assert.equal(resolveUploadDir("../../etc", env, cwd), null);
  assert.equal(resolveUploadDir("nested/child", env, cwd), null);
});

test("outbound URL guard rejects non-http protocols", () => {
  assert.throws(() => assertAllowedOutboundUrl("file:///etc/passwd"), /protocol/);
  assert.throws(() => assertAllowedOutboundUrl("not a url"), /Invalid upstream URL/);
  assert.equal(assertAllowedOutboundUrl("https://api.openai.com/v1").hostname, "api.openai.com");
});

test("outbound URL guard blocks private targets only in public deployment mode", () => {
  const publicEnv = { PUBLIC_DEPLOYMENT: "1" };

  assert.equal(assertAllowedOutboundUrl("http://localhost:11434/v1").hostname, "localhost");

  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/v1",
    "http://192.168.1.10/v1",
    "http://172.16.4.4/v1",
    "http://[::1]/v1",
    "http://metadata.google.internal/v1",
  ]) {
    assert.throws(() => assertAllowedOutboundUrl(url, publicEnv), /private network/, `expected ${url} to be blocked`);
  }

  assert.equal(assertAllowedOutboundUrl("https://api.deeplx.org/translate", publicEnv).hostname, "api.deeplx.org");
  assert.equal(isPrivateNetworkHostname("example.com"), false);
});
