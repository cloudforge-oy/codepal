/**
 * Bundle the renderer (app/renderer/src -> app/renderer/dist) with esbuild.
 *
 * Monaco ships ESM (its AMD build is deprecated), so the UI is bundled rather than
 * loaded from node_modules: the packaged app carries only the bundle, and
 * monaco-editor stays a devDependency. Outputs:
 *   dist/index.js (+ split chunks)  the UI, with Monaco's language grammars lazy-loaded
 *   dist/index.css                  Monaco's CSS (our own styles.css is linked as-is)
 *   dist/*.worker.js                Monaco's language-service web workers
 *
 * Usage: node scripts/build-renderer.mjs [--watch]
 */
import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "app", "renderer", "dist");
const watch = process.argv.includes("--watch");
const monaco = (p) => path.join(root, "node_modules", "monaco-editor", "esm", "vs", p);

fs.rmSync(outdir, { recursive: true, force: true });

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: "chrome140",
  logLevel: "info",
  legalComments: "none",
};

const ui = {
  ...common,
  entryPoints: { index: path.join(root, "app", "renderer", "src", "index.js") },
  outdir,
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  loader: { ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
};

// Workers are classic scripts so they load with a plain `new Worker(url)`.
const workers = {
  ...common,
  entryPoints: {
    "editor.worker": monaco("editor/editor.worker.js"),
    "json.worker": monaco("language/json/json.worker.js"),
    "css.worker": monaco("language/css/css.worker.js"),
    "html.worker": monaco("language/html/html.worker.js"),
    "ts.worker": monaco("language/typescript/ts.worker.js"),
  },
  outdir,
  format: "iife",
};

if (watch) {
  for (const opts of [ui, workers]) await (await context(opts)).watch();
  console.log("watching app/renderer/src …");
} else {
  await Promise.all([build(ui), build(workers)]);
}
