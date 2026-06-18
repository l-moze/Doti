const fs = require("node:fs");
const path = require("node:path");

const NEXT_DIST_DIR = process.env.NEXT_DIST_DIR || ".next-build";

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(sourcePath);
      try {
        fs.symlinkSync(link, destinationPath);
      } catch {
        // Fall back to copying the resolved target when symlinks are unsupported (e.g. exFAT).
        fs.copyFileSync(sourcePath, destinationPath);
      }
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

/**
 * electron-builder unconditionally strips `node_modules` from `extraResources`
 * (its default file matcher includes `!**\/node_modules/**`, which `filter`
 * cannot override). The Next.js standalone server requires its traced
 * `node_modules` to start, so copy them in after packaging.
 *
 * @param {{ appOutDir: string, packager: { info: { projectDir: string } } }} context
 */
exports.default = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir;
  const sourceNodeModules = path.join(projectDir, NEXT_DIST_DIR, "standalone", "node_modules");
  const targetStandalone = path.join(context.appOutDir, "resources", ".next", "standalone");
  const targetNodeModules = path.join(targetStandalone, "node_modules");

  if (!fs.existsSync(sourceNodeModules)) {
    throw new Error(
      `[afterPack] standalone node_modules not found at ${sourceNodeModules}. Run "npm run build" first.`
    );
  }

  fs.rmSync(targetNodeModules, { recursive: true, force: true });
  copyDirectory(sourceNodeModules, targetNodeModules);

  const nextPkg = path.join(targetNodeModules, "next", "package.json");
  if (!fs.existsSync(nextPkg)) {
    throw new Error(`[afterPack] copy verification failed: ${nextPkg} missing.`);
  }

  console.log(`[afterPack] Copied standalone node_modules into ${path.relative(projectDir, targetNodeModules)}.`);
};
