import { build, context } from "esbuild";
import { cp, mkdir, watch } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const outdir = path.join(root, "dist");
const assets = ["manifest.json", "popup.html", "recorder.html", "setup.html", "onboarding.html", "styles.css"];
async function copyAssets() {
  await mkdir(outdir, { recursive: true });
  await Promise.all(assets.map(file => cp(path.join(root, "src", file), path.join(outdir, file))));
}
const config = {
  absWorkingDir: root,
  entryPoints: ["background", "content", "onboarding", "popup", "recorder", "setup"].map(name => path.join(root, "src", `${name}.ts`)),
  outdir, bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: true,
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [{ name: "static-assets", setup(build) { build.onEnd(async result => { if (!result.errors.length) await copyAssets(); }); } }],
};
if (process.argv.includes("--watch")) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("Watching source and static assets. Reload the extension after changes.");
  for await (const event of watch(path.join(root, "src"))) {
    if (event.filename && assets.includes(event.filename)) await copyAssets();
  }
} else { await build(config); }
