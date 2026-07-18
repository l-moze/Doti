import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTsModule(relativePath, contextOverrides = {}, cache = new Map()) {
  const filename = path.resolve(relativePath);
  if (cache.has(filename)) {
    return cache.get(filename).exports;
  }

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
  cache.set(filename, module);
  const dirname = path.dirname(filename);
  const localRequire = (specifier) => {
    if (specifier.startsWith("@/")) {
      return loadTsModule(path.resolve("src", `${specifier.slice(2)}.ts`), contextOverrides, cache);
    }
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(dirname, specifier);
      return loadTsModule(fs.existsSync(resolved) ? resolved : `${resolved}.ts`, contextOverrides, cache);
    }
    return require(specifier);
  };

  vm.runInNewContext(output, {
    Buffer,
    console,
    exports: module.exports,
    module,
    process,
    require: localRequire,
    ...contextOverrides,
  }, { filename });

  return module.exports;
}

test("does not require a media cookie secret outside public deployment mode", () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.MEDIA_ACCESS_COOKIE_SECRET;
    delete process.env.MEDIA_TOKEN_SECRET;
    delete process.env.MEDIA_URL_SIGNING_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.PUBLIC_DEPLOYMENT;

    const { grantFileHashAccess, hasFileHashAccess } = loadTsModule("src/lib/media-session.ts");
    const request = { cookies: { get: () => undefined } };
    const response = { cookies: { set: () => assert.fail("cookie should not be set in local mode") } };

    assert.doesNotThrow(() => grantFileHashAccess(request, response, "abc123"));
    assert.equal(hasFileHashAccess(request, "abc123"), true);
  } finally {
    process.env = originalEnv;
  }
});
