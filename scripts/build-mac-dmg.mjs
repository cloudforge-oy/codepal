/**
 * Ad-hoc sign the packaged macOS apps and wrap each in a drag-to-Applications
 * DMG. Run after `electron-builder --mac dir --x64 --arm64` has populated
 * dist/mac (x64) and dist/mac-arm64 (the dist:mac npm script chains this).
 *
 * electron-builder can package the .app on Linux but not sign it or build a
 * DMG (those shell out to macOS-only codesign/sips/hdiutil). So:
 *   - on macOS: native `codesign --sign -` and `hdiutil create`;
 *   - elsewhere: the same steps in Docker (build/mac-dmg.Dockerfile) with
 *     rcodesign, mkfs.hfsplus and Mozilla's libdmg-hfsplus.
 *
 * Signing is ad-hoc (no Developer ID): Apple Silicon won't execute arm64 code
 * without a valid signature, and electron-builder's Info.plist/helper renames
 * invalidate the one Electron ships with. The app isn't notarized, so the
 * first launch needs right-click > Open (or System Settings > Privacy &
 * Security > Open Anyway).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version, productName } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const distDir = path.join(root, "dist");
const IMAGE = "codepal-dmg-tools";

// electron-builder's output dir per arch.
const targets = [
  { arch: "arm64", dir: "mac-arm64" },
  { arch: "x64", dir: "mac" },
].filter(({ dir }) => fs.existsSync(path.join(distDir, dir, `${productName}.app`)));

if (targets.length === 0) {
  console.error(`no ${productName}.app under dist/mac*/ — run \`npm run dist:mac\` (electron-builder) first.`);
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });

// Runs inside the container: sign, then build an HFS+ volume from the arch's
// dist dir (CodePal.app + Applications symlink) and compress it to UDIF/zlib.
const LINUX_SCRIPT = String.raw`
set -euo pipefail
src="$1" out="$2" vol="$3"
rcodesign sign "$src/$vol.app" 2>&1 | tail -n 1
mb=$(du -sm "$src" | cut -f1)
img=$(mktemp /tmp/volume-XXXXXX.hfs)
truncate -s "$((mb + mb / 5 + 64))M" "$img"
mkfs.hfsplus -v "$vol" "$img" >/dev/null
hfsplus "$img" addall "$src" / --symlinks clone_link --special-modes no >/dev/null
dmg build "$img" "$out" >/dev/null
rm -f "$img"
`;

function ensureDockerImage() {
  console.log(`docker: building ${IMAGE} (cached after the first run) ...`);
  run("docker", ["build", "-q", "-t", IMAGE, "-f", path.join(root, "build", "mac-dmg.Dockerfile"), path.join(root, "build")],
    { stdio: ["ignore", "ignore", "inherit"] });
}

if (process.platform !== "darwin") ensureDockerImage();

for (const { arch, dir } of targets) {
  const srcDir = path.join(distDir, dir);
  const appPath = path.join(srcDir, `${productName}.app`);
  const outName = `${productName}-${version}-${arch}.dmg`;
  const outFile = path.join(distDir, outName);
  const appsLink = path.join(srcDir, "Applications");

  console.log(`building ${outFile} from ${appPath} ...`);
  fs.rmSync(outFile, { force: true });
  fs.rmSync(appsLink, { force: true });
  fs.symlinkSync("/Applications", appsLink); // the drag target in the DMG window
  try {
    if (process.platform === "darwin") {
      run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
      run("codesign", ["--verify", "--deep", "--strict", appPath]);
      run("hdiutil", ["create", "-volname", productName, "-srcfolder", srcDir, "-ov", "-format", "UDZO", outFile]);
    } else {
      const { uid, gid } = os.userInfo();
      run("docker", [
        "run", "--rm", "--user", `${uid}:${gid}`, "-e", "HOME=/tmp",
        "-v", `${distDir}:/dist`, IMAGE,
        "bash", "-c", LINUX_SCRIPT, "build-dmg", `/dist/${dir}`, `/dist/${outName}`, productName,
      ]);
    }
  } finally {
    fs.rmSync(appsLink, { force: true });
  }
  console.log(`built ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(0)} MB)`);
}
