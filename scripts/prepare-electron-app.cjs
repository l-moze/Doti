const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const appRoot = path.join(projectRoot, ".desktop-app");
const electronSourceDir = path.join(projectRoot, "electron");
const electronTargetDir = path.join(appRoot, "electron");
const rootPackage = require(path.join(projectRoot, "package.json"));

function removeDirectory(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDirectory(source, destination) {
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

removeDirectory(appRoot);
copyDirectory(electronSourceDir, electronTargetDir);

const desktopPackage = {
  name: rootPackage.name,
  version: rootPackage.version,
  private: true,
  main: "electron/main.cjs",
  description: "Doti desktop shell",
  author: rootPackage.author || "",
};

fs.writeFileSync(
  path.join(appRoot, "package.json"),
  `${JSON.stringify(desktopPackage, null, 2)}\n`,
  "utf-8"
);

console.log(`[prepare-electron-app] Prepared ${path.relative(projectRoot, appRoot)}.`);
