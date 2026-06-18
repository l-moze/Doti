import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildBackendUrl,
  createDesktopEnvironment,
  readRuntimeConfig,
} from "../electron/runtime.cjs";

test("maps app://local requests to the loopback backend", () => {
  const backend = new URL("http://127.0.0.1:51234");

  assert.equal(
    buildBackendUrl("app://local/api/history?limit=1", backend).toString(),
    "http://127.0.0.1:51234/api/history?limit=1"
  );
  assert.equal(
    buildBackendUrl("app://local/_next/static/chunk.js", backend).toString(),
    "http://127.0.0.1:51234/_next/static/chunk.js"
  );
});

test("ignores non-local app protocol hosts", () => {
  const backend = new URL("http://127.0.0.1:51234");

  assert.throws(
    () => buildBackendUrl("app://other/api/history", backend),
    /Unsupported app protocol host/
  );
});

test("creates desktop environment from runtime config and generated paths", () => {
  const env = createDesktopEnvironment({
    baseEnv: { EXISTING: "keep" },
    runtimeConfig: {
      MINERU_API_KEY: "mineru",
      NESTED: { ignored: true },
      EMPTY: "",
      NUMBER_VALUE: 42,
    },
    token: "token",
    port: 51234,
    hostname: "127.0.0.1",
    paths: {
      uploadsRoot: "D:/Doti/user/storage/uploads",
      cacheRoot: "D:/Doti/user/cache",
      configRoot: "D:/Doti/user/config",
      termsRoot: "D:/Doti/resources/terms",
    },
  });

  assert.equal(env.EXISTING, "keep");
  assert.equal(env.MINERU_API_KEY, "mineru");
  assert.equal(env.NUMBER_VALUE, "42");
  assert.equal(env.EMPTY, undefined);
  assert.equal(env.NESTED, undefined);
  assert.equal(env.DESKTOP_MODE, "1");
  assert.equal(env.DESKTOP_AUTH_TOKEN, "token");
  assert.equal(env.PORT, "51234");
  assert.equal(env.HOSTNAME, "127.0.0.1");
  assert.equal(env.DESKTOP_UPLOADS_ROOT, path.resolve("D:/Doti/user/storage/uploads"));
});

test("returns empty runtime config when runtime.json is absent", () => {
  assert.deepEqual(readRuntimeConfig(path.resolve("D:/missing/doti/config")), {});
});
