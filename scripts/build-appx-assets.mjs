/**
 * Render the Microsoft Store (MSIX) tile assets from build/icon.png into build/appx/,
 * where electron-builder's appx target picks them up by name. Without them the package
 * ships electron-builder's default placeholder tiles.
 *
 * Run with: npx electron scripts/build-appx-assets.mjs
 */
import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build", "appx");

// name -> [width, height, share of the shorter side the icon fills]
const ASSETS = {
  "StoreLogo.png": [50, 50, 1],
  "Square44x44Logo.png": [44, 44, 1],
  "Square150x150Logo.png": [150, 150, 0.66],
  "Wide310x150Logo.png": [310, 150, 0.66],
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  await mkdir(outDir, { recursive: true });
  const icon = (await readFile(path.join(root, "build", "icon.png"))).toString("base64");
  const win = new BrowserWindow({
    width: 320,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
  });
  await win.loadURL("data:text/html,<body style='margin:0;overflow:hidden'></body>");

  for (const [name, [w, h, fill]] of Object.entries(ASSETS)) {
    const side = Math.round(Math.min(w, h) * fill);
    await win.webContents.executeJavaScript(`(() => {
      document.body.innerHTML =
        '<div style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">' +
        '<img style="width:${side}px;height:${side}px" src="data:image/png;base64,${icon}"></div>';
      return new Promise((r) => { const i = document.querySelector("img"); i.complete ? r() : (i.onload = r); });
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    await writeFile(path.join(outDir, name), shot.resize({ width: w, height: h }).toPNG());
    console.log(`build/appx/${name}  ${w}x${h}`);
  }
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
