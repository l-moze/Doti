const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const nextDistDir = process.env.NEXT_DIST_DIR || ".next-build";
const standaloneRoot = path.join(projectRoot, nextDistDir, "standalone");

const prunedStandaloneEntries = [
  ".cache",
  ".desktop-app",
  ".git",
  "dist-electron",
  "electron",
  "scripts",
  "tests",
  "uploads",
  "table-debug-print.png",
];

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
      continue;
    }

    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

if (!fs.existsSync(standaloneRoot)) {
  console.warn("[prepare-standalone] .next/standalone not found; skipping resource copy.");
  process.exit(0);
}

for (const entry of prunedStandaloneEntries) {
  removePath(path.join(standaloneRoot, entry));
}

copyDirectory(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"));
copyDirectory(path.join(projectRoot, nextDistDir, "static"), path.join(standaloneRoot, nextDistDir, "static"));

console.log(`[prepare-standalone] Pruned desktop-only files and copied public/static into ${nextDistDir}/standalone.`);
