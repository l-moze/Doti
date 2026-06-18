const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const LOOPBACK_HOST = "127.0.0.1";
const RUNTIME_CONFIG_FILE = "runtime.json";

function buildBackendUrl(appUrl, backendOrigin) {
  const sourceUrl = new URL(appUrl);
  if (sourceUrl.protocol !== "app:" || sourceUrl.hostname !== "local") {
    throw new Error(`Unsupported app protocol host: ${sourceUrl.host}`);
  }

  const targetUrl = new URL(backendOrigin.toString());
  targetUrl.pathname = sourceUrl.pathname;
  targetUrl.search = sourceUrl.search;
  targetUrl.hash = "";
  return targetUrl;
}

function readRuntimeConfig(configRoot) {
  const runtimeConfigPath = path.join(configRoot, RUNTIME_CONFIG_FILE);

  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function assignRuntimeConfigEnv(target, runtimeConfig) {
  for (const [key, value] of Object.entries(runtimeConfig || {})) {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      continue;
    }

    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }

    const serializedValue = String(value).trim();
    if (!serializedValue) {
      continue;
    }

    target[key] = serializedValue;
  }
}

function createDesktopEnvironment(input) {
  const env = { ...(input.baseEnv || {}) };
  assignRuntimeConfigEnv(env, input.runtimeConfig);

  env.NODE_ENV = "production";
  env.PORT = String(input.port);
  env.HOSTNAME = input.hostname || LOOPBACK_HOST;
  env.DESKTOP_MODE = "1";
  env.DESKTOP_AUTH_TOKEN = input.token;
  env.DESKTOP_UPLOADS_ROOT = path.resolve(input.paths.uploadsRoot);
  env.DESKTOP_CACHE_ROOT = path.resolve(input.paths.cacheRoot);
  env.DESKTOP_CONFIG_ROOT = path.resolve(input.paths.configRoot);
  env.DESKTOP_TERMS_ROOT = path.resolve(input.paths.termsRoot);

  return env;
}

function findAvailablePort(hostname = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Unable to allocate loopback port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function waitForHttpServer(url, options = {}) {
  const timeoutMs = options.timeoutMs || 30_000;
  const intervalMs = options.intervalMs || 250;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", (error) => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }

        setTimeout(attempt, intervalMs);
      });

      request.setTimeout(intervalMs, () => {
        request.destroy();
      });
    };

    attempt();
  });
}

module.exports = {
  LOOPBACK_HOST,
  RUNTIME_CONFIG_FILE,
  buildBackendUrl,
  createDesktopEnvironment,
  findAvailablePort,
  readRuntimeConfig,
  waitForHttpServer,
};
