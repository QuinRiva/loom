// Parse-damage sweep (doc 24 method note, rebuilt on esbuild: TS7's JS API is gone).
import * as NodeFS from "node:fs";
// Resolve esbuild from the current worktree's store (run from the repo root).
const esbuildMain = NodeFS.globSync("node_modules/.pnpm/esbuild@*/node_modules/esbuild/lib/main.js")
  .sort()
  .at(-1);
const esbuild = await import(new URL(esbuildMain, `file://${process.cwd()}/`).href);
const files = process.argv.slice(2);
let bad = 0,
  conflicted = 0;
for (const f of files) {
  if (!NodeFS.existsSync(f)) continue;
  const src = NodeFS.readFileSync(f, "utf8");
  if (src.includes("<<<<<<<")) {
    conflicted++;
    console.log(`CONFLICT ${f}`);
    continue;
  }
  try {
    await esbuild.transform(src, { loader: f.endsWith(".tsx") ? "tsx" : "ts", jsx: "preserve" });
  } catch (e) {
    bad++;
    for (const err of (e.errors ?? []).slice(0, 2)) {
      console.log(`PARSE ${f}:${err.location?.line ?? "?"} ${err.text}`);
    }
  }
}
console.log(`swept ${files.length} | parse-damaged ${bad} | still-conflicted ${conflicted}`);
