#!/usr/bin/env node
/** Render-health gate for MDX docs on the renderer's real module graph (jsdom + vite): lints with
 * `planLint.ts`, renders lint-clean docs (exit 0 means it renders in-app), and on plans, briefs and
 * recaps checks frontmatter `status` and the links between them. `--out` writes a standalone page,
 * `--png` slices it for a model to read; `--links-only <files or dirs>...` runs the frontmatter stage alone. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex === -1 ? undefined : args[outIndex + 1];
const png = args.includes("--png");
const linksOnly = args.includes("--links-only");

/** Lifecycle kind by root-relative path; `plans/renderer-audit/` and `plans/mdx-review-blocks/` are render fixtures, not plans. */
function kindOf(relative) {
  if (
    relative.startsWith("plans/renderer-audit/") ||
    relative.startsWith("plans/mdx-review-blocks/")
  )
    return undefined;
  if (/^plans\/(.+\/plan\.mdx?|[^/]+\.md)$/.test(relative)) return "plan";
  if (/^plans\/.+\/intent\.mdx?$/.test(relative)) return "brief";
  if (/^recaps\/.+\/recap\.mdx$/.test(relative)) return "recap";
  return undefined;
}

// Link targets resolve against the document's own repo, not the cwd's (lint-doc.sh may run
// from another checkout, and fathom's plans live in a nested worktree).
const roots = new Map();
function rootOf(dir) {
  if (!roots.has(dir)) {
    let root = dir;
    try {
      root = NodeChildProcess.execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
    roots.set(dir, root);
  }
  return roots.get(dir);
}

function expand(input) {
  const path = NodePath.resolve(process.cwd(), input);
  const directory = NodeFS.statSync(path).isDirectory();
  const root = rootOf(directory ? path : NodePath.dirname(path));
  const paths = directory
    ? NodeFS.readdirSync(path, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => NodePath.join(entry.parentPath, entry.name))
    : [path];
  return paths
    .map((file) => ({ path: file, root, kind: kindOf(NodePath.relative(root, file)) }))
    .filter((doc) => !directory || doc.kind);
}

const docs = args
  .filter((arg, index) => !arg.startsWith("--") && (outIndex === -1 || index !== outIndex + 1))
  .flatMap(expand);
if (
  !docs.length ||
  (outIndex !== -1 && !outFile) ||
  (png && !outFile) ||
  (outFile && docs.length > 1)
) {
  console.error(
    "Usage: node apps/web/scripts/lint-plan.mjs <plan.mdx> [--out <file.html> [--png]] | --links-only <files or dirs>...",
  );
  process.exit(2);
}

// DOM globals for the wireframe sanitiser dry-run.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "DOMParser",
  "XMLSerializer",
  "Element",
  "Node",
  "HTMLElement",
  "HTMLTemplateElement",
  "SVGElement",
  "CSS",
  "customElements",
  "CustomEvent",
  "Event",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
]) {
  if (!(key in globalThis) && dom.window[key] !== undefined) globalThis[key] = dom.window[key];
}

const webRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  configFile: false,
  root: webRoot,
  logLevel: "error",
  // Only `--out` needs a stylesheet, and compiling Tailwind costs a second.
  plugins: outFile ? (await import("@tailwindcss/vite")).default() : [],
  server: { middlewareMode: true, hmr: false, watch: null },
  resolve: { alias: { "~": NodePath.join(webRoot, "src") } },
  optimizeDeps: { noDiscovery: true },
  // `lucide` (reached via ChatMarkdown) ships CJS `main` with no `exports`; vite-plus
  // inlines it into the ESM runner ("exports is not defined"). Node loads it natively.
  ssr: { external: ["lucide"] },
});

/**
 * Stage 2: compile + SSR-render the document through the real block registry and
 * report findings for a render that threw or produced degraded blocks. Prints a
 * one-line positive signal (bytes + rendered block-type counts) so a passing run
 * shows WHAT mounted, not just that nothing failed.
 */
async function renderFindings(mdxSource, planDir) {
  const load = (module) => server.ssrLoadModule(`/src/components/files/mdx-plan/${module}`);
  const [
    { compilePlanMdx },
    { PLAN_BLOCK_COMPONENTS },
    { PlanEagerMountContext },
    { PlanDocumentContext },
    { renderedTextFindings },
  ] = await Promise.all([
    load("mdxCompileOptions.ts"),
    load("registry.tsx"),
    load("planEagerMount.ts"),
    load("planDocument.ts"),
    load("planLint.ts"),
  ]);

  let html;
  try {
    const Content = await compilePlanMdx(mdxSource);
    // Eager mount so lazily-mounted containers (`<Details>`, tabs) materialise
    // their children — the same thing the annotation layer does. The document
    // location resolves `<Image src>` against the document's own directory;
    // with no thread to sign an asset URL, images fall back to `file://`.
    html = renderToStaticMarkup(
      createElement(
        PlanDocumentContext.Provider,
        { value: { baseDir: planDir } },
        createElement(
          PlanEagerMountContext.Provider,
          { value: true },
          createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
        ),
      ),
    );
  } catch (cause) {
    return {
      findings: [
        {
          severity: "error",
          message: `render threw (the document fails to display): ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }

  const counts = {};
  for (const [, type] of html.matchAll(/data-plan-block-type="([^"]+)"/g)) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const rendered = Object.entries(counts)
    .map(([type, count]) => `${type}×${count}`)
    .join(", ");
  console.log(`render: ${html.length} bytes of HTML, blocks mounted: ${rendered || "none"}`);

  return {
    html,
    findings: [
      // A block whose props its schema rejects at render (e.g. prose children lint
      // cannot see) degrades to an error card instead of throwing; the card carries
      // the reason, so quote it back stripped of markup.
      ...[...html.matchAll(/data-plan-block-error="([^"]+)"/g)].map(({ 1: tag, index }) => ({
        severity: "error",
        message: `<${tag}> rendered as an in-document error card: ${html
          .slice(html.indexOf(">", index) + 1, index + 800)
          .replace(/<[^>]*>/g, " ")
          .replace(
            /&(lt|gt|quot|amp|#39);/g,
            (_, name) => ({ lt: "<", gt: ">", quot: '"', amp: "&", "#39": "'" })[name],
          )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300)}`,
      })),
      // An `<Image>` whose file is not on disk renders as a broken image in the
      // app and an empty box in `--out`; the resolved path is stamped for us.
      ...[...html.matchAll(/data-plan-image-path="([^"]+)"/g)]
        .map(({ 1: path }) => path.replaceAll("&amp;", "&").replaceAll("&quot;", '"'))
        .filter((path) => !NodeFS.existsSync(path))
        .map((path) => ({
          severity: "error",
          message: `<Image> file not found: ${path} — the src is resolved relative to the document's own directory.`,
        })),
      ...renderedTextFindings(html),
    ],
  };
}

/** Standalone page with the app's stylesheet, `MdxPlanRenderer`'s root wrapper and its
 * `data-plan-bleed` stamps, so blocks get the in-app measure and bleed. The bleed budget
 * keys off `100vw` as the panel's keys off the panel, so the app's HTML preview lays it
 * out at the panel's width. */
async function writeStandalonePage(html, target, planPath) {
  const css = (await server.transformRequest("/src/index.css?direct"))?.code ?? "";
  const { stampBleedingBlocks } = await server.ssrLoadModule(
    "/src/components/files/mdx-plan/MdxPlanRenderer.tsx",
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  stampBleedingBlocks(root);
  // A `file://` src is unloadable in the app's HTML preview (an iframe on the app
  // origin), and the server resolves a preview's subresources by joining onto the
  // page's own directory — no `..` segments. So relative wins wherever the image
  // sits under the output directory, and `file://` stays for anything above it.
  const outDir = NodePath.dirname(target);
  const body = root.innerHTML.replaceAll(/src="file:\/\/([^"]*)"/g, (match, encoded) => {
    const relative = NodePath.relative(outDir, decodeURI(encoded));
    return relative.startsWith("..") || NodePath.isAbsolute(relative)
      ? match
      : `src="${encodeURI(relative.split(NodePath.sep).join("/"))}"`;
  });
  const page = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NodePath.basename(planPath)}</title>
<style>${css}</style>
</head>
<body class="bg-background text-foreground" style="--timeline-available-width: 100vw">
<div data-plan-root class="plan-mdx mx-auto max-w-4xl px-6 py-5">${body}</div>
</body>
</html>
`;
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, page);
  console.log(`wrote ${shown(target)} (${page.length} bytes)`);
}

// 1024 wide holds the in-app prose measure (`max-w-4xl` + padding) with the
// margin a panel has; 1024×1100 sits just under the ~1.15 MP a model reads at
// native resolution, so 14px body text in a slice stays legible.
const PNG_WIDTH = 1024;
const PNG_SLICE_HEIGHT = 1100;

/** Screenshot the standalone page as page-height slices beside it. Loaded over
 * `file://` so the relative image srcs the page was written with resolve. Each
 * slice scrolls the viewport rather than using `fullPage`, which resizes the
 * render surface to the whole document and fails intermittently past ~10k px. */
async function writeScreenshots(pageFile) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: PNG_WIDTH, height: PNG_SLICE_HEIGHT },
    });
    await page.goto(NodeURL.pathToFileURL(pageFile).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const stem = pageFile.replace(/\.html?$/, "");
    const slices = Math.max(1, Math.ceil(height / PNG_SLICE_HEIGHT));
    for (let index = 0; index < slices; index++) {
      const y = index * PNG_SLICE_HEIGHT;
      const target = `${stem}-${index + 1}.png`;
      // The last scroll clamps short of `y`; clip from where `y` landed in the viewport.
      const scrollY = await page.evaluate((top) => {
        window.scrollTo(0, top);
        return Math.round(window.scrollY);
      }, y);
      await page.screenshot({
        path: target,
        animations: "disabled",
        clip: {
          x: 0,
          y: y - scrollY,
          width: PNG_WIDTH,
          height: Math.min(PNG_SLICE_HEIGHT, height - y),
        },
      });
      console.log(`wrote ${shown(target)} (slice ${index + 1} of ${slices}, ${height}px page)`);
    }
  } finally {
    await browser.close();
  }
}

function shown(target) {
  const relative = NodePath.relative(process.cwd(), target);
  return relative.startsWith("..") ? target : relative;
}

/** Render findings as terse `file:line:col severity: message` lines. */
function formatFindings(findings, file) {
  if (!findings.length) return `${file}: OK \u2014 no findings.`;
  return findings
    .map(
      (finding) =>
        `${file}${finding.line !== undefined ? `:${finding.line}${finding.column !== undefined ? `:${finding.column}` : ""}` : ""} ${finding.severity}: ${finding.message}`,
    )
    .join("\n");
}

const STATUSES = ["draft", "approved", "done", "dropped", "superseded"];
const RECIPROCAL = {
  intent: "plan",
  recap: "plan",
  supersedes: "superseded_by",
  superseded_by: "supersedes",
};

/** Stage 3, plans/briefs/recaps only: `status` and the links between them, per
 * skills/mdx-visual-plan/SKILL.md 'The plan's life'. A plan or brief carries `status`; a
 * recap is checked only for its `plan:`. Each link's target must exist and point back. */
function lifecycleFindings({ path, root, kind }, source, readFrontmatter) {
  const frontmatter = readFrontmatter(source) ?? {};
  const line = (field) => ({
    line: source.split("\n").findIndex((l) => l.startsWith(`${field}:`)) + 1,
  });
  const relative = NodePath.relative(root, path);
  const findings = [];
  if (kind !== "recap") {
    if (frontmatter.status === undefined) {
      findings.push({
        severity: "warning",
        message:
          "No `status:` in frontmatter; `draft`, `approved`, `done`, `dropped` or `superseded` (skills/mdx-visual-plan/SKILL.md, 'The plan's life')",
      });
    } else if (!STATUSES.includes(frontmatter.status)) {
      findings.push({
        severity: "error",
        ...line("status"),
        message: `\`status: ${frontmatter.status}\` is not one of ${STATUSES.join(", ")}`,
      });
    }
    if (frontmatter.status === "superseded" && frontmatter.superseded_by === undefined) {
      findings.push({
        severity: "error",
        ...line("status"),
        message:
          "`status: superseded` without `superseded_by:` naming the plan (or `upstream:#…` / URL) that replaced it",
      });
    }
  }
  for (const field of kind === "recap" ? ["plan"] : Object.keys(RECIPROCAL).concat("plan")) {
    const target = frontmatter[field];
    if (target === undefined || /^(upstream:|https?:\/\/)/.test(target)) continue;
    const targetPath = NodePath.join(root, target);
    if (!NodeFS.existsSync(targetPath)) {
      findings.push({
        severity: "error",
        ...line(field),
        message: `\`${field}: ${target}\` names a file that does not exist`,
      });
      continue;
    }
    const back = field === "plan" ? (kind === "brief" ? "intent" : "recap") : RECIPROCAL[field];
    if ((readFrontmatter(NodeFS.readFileSync(targetPath, "utf8")) ?? {})[back] !== relative) {
      findings.push({
        severity: "warning",
        ...line(field),
        message: `\`${field}: ${target}\` is one-way; add \`${back}: ${relative}\` to ${target}`,
      });
    }
  }
  return findings;
}

const all = [];
try {
  const { lintPlanSource, readFrontmatter } = await server.ssrLoadModule(
    "/src/components/files/mdx-plan/planLint.ts",
  );
  for (const doc of docs) {
    const source = NodeFS.readFileSync(doc.path, "utf8");
    const findings = [];
    if (!linksOnly && doc.path.endsWith(".mdx")) {
      findings.push(...(await lintPlanSource(source)));
      // A lint error already breaks the render; rendering would only repeat it.
      if (!findings.some((finding) => finding.severity === "error")) {
        const render = await renderFindings(source, NodePath.dirname(doc.path));
        findings.push(...render.findings);
        if (outFile && render.html !== undefined) {
          const pageFile = NodePath.resolve(process.cwd(), outFile);
          await writeStandalonePage(render.html, pageFile, doc.path);
          if (png) await writeScreenshots(pageFile);
        }
      }
    }
    if (doc.kind) findings.push(...lifecycleFindings(doc, source, readFrontmatter));
    console.log(formatFindings(findings, shown(doc.path)));
    all.push(...findings);
  }
} finally {
  await server.close();
}
const errors = all.filter((finding) => finding.severity === "error").length;
if (all.length) console.log(`\n${errors} error(s), ${all.length - errors} warning(s)`);
process.exit(errors ? 1 : 0);
