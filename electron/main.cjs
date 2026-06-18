const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, net, protocol } = require("electron");

const {
  LOOPBACK_HOST,
  buildBackendUrl,
  createDesktopEnvironment,
  findAvailablePort,
  readRuntimeConfig,
  waitForHttpServer,
} = require("./runtime.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
      stream: true,
    },
  },
]);

let nextServerProcess = null;

function getAppDataRoot() {
  return path.join(app.getPath("userData"), "doti");
}

function diagLog(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "doti-diag.log"), line);
  } catch {
    /* ignore */
  }
}

function getResourceRoot() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }

  return path.resolve(__dirname, "..");
}

function getStandaloneServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ".next", "standalone", "server.js");
  }

  const nextDistDir = process.env.NEXT_DIST_DIR || ".next-build";
  return path.resolve(__dirname, "..", nextDistDir, "standalone", "server.js");
}

function ensureRuntimeDirectories(paths) {
  fs.mkdirSync(paths.uploadsRoot, { recursive: true });
  fs.mkdirSync(paths.cacheRoot, { recursive: true });
  fs.mkdirSync(paths.configRoot, { recursive: true });
}

function createRuntimePaths() {
  const appDataRoot = getAppDataRoot();
  return {
    uploadsRoot: path.join(appDataRoot, "storage", "uploads"),
    cacheRoot: path.join(appDataRoot, "cache"),
    configRoot: path.join(appDataRoot, "config"),
    termsRoot: path.join(getResourceRoot(), "terms"),
  };
}

function spawnNextServer(serverPath, env) {
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Next standalone server not found at ${serverPath}. Run npm run build first.`);
  }

  const childEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  };

  return spawn(process.execPath, [serverPath], {
    env: childEnv,
    cwd: path.dirname(serverPath),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function registerAppProtocolProxy(backendOrigin, desktopAuthToken) {
  protocol.handle("app", async (request) => {
    const targetUrl = buildBackendUrl(request.url, backendOrigin);
    const headers = new Headers(request.headers);
    headers.set("x-desktop-auth", desktopAuthToken);

    return net.fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
    });
  });
}

async function createWindow() {
  const runtimePaths = createRuntimePaths();
  ensureRuntimeDirectories(runtimePaths);

  const port = await findAvailablePort(LOOPBACK_HOST);
  const desktopAuthToken = crypto.randomBytes(32).toString("base64url");
  const runtimeConfig = readRuntimeConfig(runtimePaths.configRoot);
  const backendOrigin = new URL(`http://${LOOPBACK_HOST}:${port}`);
  const env = createDesktopEnvironment({
    baseEnv: process.env,
    runtimeConfig,
    token: desktopAuthToken,
    port,
    hostname: LOOPBACK_HOST,
    paths: runtimePaths,
  });

  const serverPath = getStandaloneServerPath();
  nextServerProcess = spawnNextServer(serverPath, env);
  nextServerProcess.stdout.on("data", (chunk) => {
    console.log(`[next] ${chunk.toString().trimEnd()}`);
  });
  nextServerProcess.stderr.on("data", (chunk) => {
    console.error(`[next] ${chunk.toString().trimEnd()}`);
  });
  nextServerProcess.on("error", (err) => {
    diagLog(`next spawn error: ${err && err.stack ? err.stack : err}`);
  });
  nextServerProcess.once("exit", (code, signal) => {
    nextServerProcess = null;
    if (!app.isQuitting) {
      diagLog(`next server exited unexpectedly code=${code ?? "null"} signal=${signal ?? "null"}`);
      console.error(`[next] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      app.quit();
    }
  });

  await waitForHttpServer(backendOrigin.toString());
  registerAppProtocolProxy(backendOrigin, desktopAuthToken);

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://local/")) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  await win.loadURL("app://local/");
}

app.on("before-quit", () => {
  app.isQuitting = true;
  if (nextServerProcess && !nextServerProcess.killed) {
    nextServerProcess.kill();
  }
});

app.whenReady().then(createWindow).catch((error) => {
  diagLog(`failed to start: ${error && error.stack ? error.stack : error}`);
  console.error("[electron] failed to start:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});
