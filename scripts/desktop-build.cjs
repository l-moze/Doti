const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Orchestrates a Windows desktop build with a clean, self-contained environment
// (no reliance on shell env), so `npm run desktop:build` / `desktop:dir` behave
// identically regardless of leftover variables in the caller's session.
const projectRoot = path.resolve(__dirname, "..");

const target = process.argv.includes("--dir") ? "--dir" : "--win";

const childEnv = {
  ...process.env,
  // Run Electron as Electron, never as plain Node — a leaked ELECTRON_RUN_AS_NODE
  // makes `require("electron")` return a path string and the app exits silently.
  ELECTRON_RUN_AS_NODE: undefined,
  // No code-signing certificate; the default signer downloads winCodeSign from
  // GitHub during packaging (see scripts/no-op-sign.cjs).
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const isWindows = process.platform === "win32";

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: childEnv,
    stdio: "inherit",
    shell: isWindows, // resolve .cmd shims (next, electron-builder) on Windows
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("next", ["build"]);
run("node", ["scripts/prepare-standalone.cjs"]);
run("node", ["scripts/prepare-electron-app.cjs"]);
run("electron-builder", [target]);
