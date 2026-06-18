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
  }, { filename });

  return module.exports;
}

const {
  getCacheRoot,
  getConfigRoot,
  getPdfParseCacheDir,
  getTermsRoot,
  getUploadsRoot,
  resolveUploadDir,
} = loadTsModule("src/lib/server/runtime-paths.ts");

test("uses project-local fallback paths outside desktop mode", () => {
  const cwd = path.resolve("F:/Example/Doti");
  const env = {};

  assert.equal(getUploadsRoot(env, cwd), path.join(cwd, "uploads"));
  assert.equal(getCacheRoot(env, cwd), path.join(cwd, ".cache"));
  assert.equal(getPdfParseCacheDir(env, cwd), path.join(cwd, ".cache", "pdf-parse"));
  assert.equal(getConfigRoot(env, cwd), path.join(cwd, ".cache", "desktop-config"));
  assert.equal(getTermsRoot(env, cwd), path.join(cwd, "terms"));
});

test("honors desktop runtime path overrides", () => {
  const cwd = path.resolve("F:/Example/Doti");
  const env = {
    DESKTOP_UPLOADS_ROOT: "D:/DotiUser/storage/uploads",
    DESKTOP_CACHE_ROOT: "D:/DotiUser/cache",
    DESKTOP_CONFIG_ROOT: "D:/DotiUser/config",
    DESKTOP_TERMS_ROOT: "D:/DotiResources/terms",
  };

  assert.equal(getUploadsRoot(env, cwd), path.resolve("D:/DotiUser/storage/uploads"));
  assert.equal(getCacheRoot(env, cwd), path.resolve("D:/DotiUser/cache"));
  assert.equal(getPdfParseCacheDir(env, cwd), path.resolve("D:/DotiUser/cache/pdf-parse"));
  assert.equal(getConfigRoot(env, cwd), path.resolve("D:/DotiUser/config"));
  assert.equal(getTermsRoot(env, cwd), path.resolve("D:/DotiResources/terms"));
});

test("keeps upload directories inside the uploads root", () => {
  const cwd = path.resolve("F:/Example/Doti");
  const env = { DESKTOP_UPLOADS_ROOT: "D:/DotiUser/storage/uploads" };

  assert.equal(
    resolveUploadDir("abc123", env, cwd),
    path.resolve("D:/DotiUser/storage/uploads/abc123")
  );
  assert.equal(resolveUploadDir("..", env, cwd), null);
  assert.equal(resolveUploadDir("", env, cwd), null);
});
