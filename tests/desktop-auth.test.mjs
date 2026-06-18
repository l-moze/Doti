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
    Headers,
  }, { filename });

  return module.exports;
}

const { isDesktopApiAuthorized } = loadTsModule("src/lib/server/desktop-auth.ts");

test("allows requests when desktop mode is disabled", () => {
  const headers = new Headers();
  const env = {};

  assert.equal(isDesktopApiAuthorized(headers, env), true);
});

test("requires matching desktop auth token in desktop mode", () => {
  const headers = new Headers({ "x-desktop-auth": "secret" });
  const env = {
    DESKTOP_MODE: "1",
    DESKTOP_AUTH_TOKEN: "secret",
  };

  assert.equal(isDesktopApiAuthorized(headers, env), true);
});

test("rejects missing or mismatched desktop auth token in desktop mode", () => {
  const env = {
    DESKTOP_MODE: "1",
    DESKTOP_AUTH_TOKEN: "secret",
  };

  assert.equal(isDesktopApiAuthorized(new Headers(), env), false);
  assert.equal(
    isDesktopApiAuthorized(new Headers({ "x-desktop-auth": "wrong" }), env),
    false
  );
});
