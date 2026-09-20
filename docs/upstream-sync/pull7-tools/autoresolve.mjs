// Parser-verified conflict resolver: for each file try union, then ours, then theirs;
// keep the first variant esbuild can parse. Records every dropped side for audit.
import * as esbuild from "/home/Carl/.t3/cockpit/worktrees/loom/t3code-ea251a06/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js";
import fs from "node:fs";

const PROTECT =
  /(src\/ws\.ts|orchestration\/decider\.ts|ProjectionSnapshotQuery|McpSessionRegistry|RpcAuthorization|LoomMigrations|persistence\/Migrations|ChatView|ChatComposer|ChatMarkdown|MessagesTimeline|components\/Sidebar|RightPanelTabs|client-runtime\/src\/state\/shell\.ts|threadActivity|use-selected-thread-requests|ProviderModelsSection|ModelPickerContent|keybindings|serverSettings|rightPanelStore|routeTree)/;

const MARK = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/m;
function split(src) {
  const parts = [];
  let rest = src;
  for (;;) {
    const m = MARK.exec(rest);
    if (!m) { parts.push({ text: rest }); break; }
    parts.push({ text: rest.slice(0, m.index) });
    parts.push({ ours: m[1], theirs: m[2] });
    rest = rest.slice(m.index + m[0].length);
  }
  return parts;
}
function render(parts, mode) {
  return parts.map((p) => {
    if (p.text !== undefined) return p.text;
    if (mode === "ours") return p.ours;
    if (mode === "theirs") return p.theirs;
    const seen = new Set(p.ours.split("\n").map((l) => l.trim()).filter(Boolean));
    const extra = p.theirs.split("\n").filter((l) => !l.trim() || !seen.has(l.trim()));
    return p.ours + (extra.join("\n").trim() ? extra.join("\n").replace(/\n*$/, "\n") : "");
  }).join("");
}
async function parses(src, file) {
  if (!/\.tsx?$/.test(file)) return true;
  try {
    await esbuild.transform(src, { loader: file.endsWith(".tsx") ? "tsx" : "ts", jsx: "preserve" });
    return true;
  } catch { return false; }
}

const files = fs.readFileSync("/tmp/conf.txt", "utf8").split("\n").map((l) => l.trim()).filter((f) => f && !PROTECT.test(f));
const ledger = [];
const counts = { union: 0, ours: 0, theirs: 0, failed: 0 };
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, "utf8");
  const parts = split(src);
  const hunks = parts.filter((p) => p.text === undefined);
  if (!hunks.length) continue;
  let chosen = null;
  for (const mode of ["union", "ours", "theirs"]) {
    const out = render(parts, mode);
    if (await parses(out, f)) { chosen = mode; fs.writeFileSync(f, out); break; }
  }
  if (!chosen) { counts.failed++; ledger.push({ file: f, mode: "FAILED", hunks: hunks.length }); continue; }
  counts[chosen]++;
  ledger.push({
    file: f, mode: chosen, hunks: hunks.length,
    dropped: chosen === "union" ? [] : hunks.map((h) => (chosen === "ours" ? h.theirs : h.ours)).filter((t) => t.trim()),
  });
}
fs.writeFileSync(".artifacts/pull7-autoresolve-ledger.json", JSON.stringify(ledger, null, 1));
console.log(JSON.stringify(counts), "files:", files.length);
