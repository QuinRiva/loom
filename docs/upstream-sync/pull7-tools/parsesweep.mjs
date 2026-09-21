// Parse-damage sweep (doc 24 method note, rebuilt on esbuild: TS7's JS API is gone).
import * as esbuild from "/home/Carl/.t3/cockpit/worktrees/loom/t3code-ea251a06/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js";
import * as NodeFS from "node:fs";
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
