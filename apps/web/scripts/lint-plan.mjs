#!/usr/bin/env node
/** Render-health gate for an MDX plan/recap, on the renderer's real module graph (jsdom + vite):
 * `node apps/web/scripts/lint-plan.mjs <doc>.mdx [--out <doc-dir>/render.html [--png]]`. Lints with
 * `planLint.ts`, then renders lint-clean docs; exit 0 means it renders in-app. `--out` writes a standalone
 * page (images beside it get relative srcs); `--png` slices it into page-height PNGs a model can read. */
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
const file = args.find(
  (arg, index) => !arg.startsWith("--") && (outIndex === -1 || index !== outIndex + 1),
);
if (!file || (outIndex !== -1 && !outFile) || (png && !outFile)) {
  console.error(
    "Usage: node apps/web/scripts/lint-plan.mjs <plan.mdx> [--out <file.html> [--png]]",
  );
  process.exit(2);
}
const planPath = NodePath.resolve(process.cwd(), file);
const planDir = NodePath.dirname(planPath);
const source = NodeFS.readFileSync(planPath, "utf8");

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
async function renderFindings(mdxSource) {
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
async function writeStandalonePage(html, target) {
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

/** Render findings as terse `file:line:col severity: message` lines + a summary. */
function formatFindings(findings, file) {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  if (!findings.length) return `${file}: OK \u2014 no findings.`;
  const lines = findings.map(
    (finding) =>
      `${file}${finding.line !== undefined ? `:${finding.line}${finding.column !== undefined ? `:${finding.column}` : ""}` : ""} ${finding.severity}: ${finding.message}`,
  );
  return [...lines, "", `${errors} error(s), ${findings.length - errors} warning(s)`].join("\n");
}

let failed = false;
try {
  const { lintPlanSource } = await server.ssrLoadModule(
    "/src/components/files/mdx-plan/planLint.ts",
  );
  const findings = await lintPlanSource(source);
  // A lint error already breaks the render; rendering would only repeat it.
  if (!findings.some((finding) => finding.severity === "error")) {
    const render = await renderFindings(source);
    findings.push(...render.findings);
    if (outFile && render.html !== undefined) {
      const pageFile = NodePath.resolve(process.cwd(), outFile);
      await writeStandalonePage(render.html, pageFile);
      if (png) await writeScreenshots(pageFile);
    }
  }
  console.log(formatFindings(findings, NodePath.relative(process.cwd(), planPath)));
  failed = findings.some((finding) => finding.severity === "error");
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
