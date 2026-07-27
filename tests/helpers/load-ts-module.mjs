import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

const DEFAULT_CONTEXT = {
  AbortController,
  AbortSignal,
  Blob,
  Buffer,
  Headers,
  Request,
  Response,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  clearTimeout,
  console,
  process,
  queueMicrotask,
  setTimeout,
  structuredClone,
};

/**
 * Transpiles a TypeScript source file and evaluates it in a fresh VM context so
 * that unit tests can exercise app modules without a bundler. Relative and `@/`
 * imports are resolved through the same loader; bare specifiers fall back to the
 * real module resolution.
 */
export function loadTsModule(relativePath, contextOverrides = {}, cache = new Map()) {
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
    ...DEFAULT_CONTEXT,
    exports: module.exports,
    module,
    require: localRequire,
    ...contextOverrides,
  }, { filename });

  return module.exports;
}
