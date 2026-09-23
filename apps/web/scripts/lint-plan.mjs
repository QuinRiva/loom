#!/usr/bin/env node
/**
 * Headless render-health check for an MDX plan/recap — the gate an agent runs
 * before handing a document to a human:
 *
 *   node apps/web/scripts/lint-plan.mjs plans/<slug>/plan.mdx [--out <file.html>]
 *
 * Two stages, both against the renderer's REAL module graph so neither can
 * drift from what the app accepts:
 *   1. lint   — `src/components/files/mdx-plan/planLint.ts` (AST rules, zod
 *               schemas, mermaid parse, wireframe sanitiser, compile gate).
 *   2. render — `compilePlanMdx` + `renderToStaticMarkup` with the real
 *               `PLAN_BLOCK_COMPONENTS` registry under eager mount, i.e. the
 *               drive `mdxPlan.test.ts` uses. Only lint-clean documents reach
 *               it. This catches what no static pass can see: a block whose
 *               component throws or degrades to an error card on payloads its
 *               schema accepts.
 *
 * Exit 0 ⇒ the document renders in-app. Non-zero ⇒ errors (broken/degraded
 * render); warnings (silent degradation) are reported but do not fail the run.
 *
 * `--out <file.html>` keeps the markup stage 2 already produces, as a standalone
 * page with the app's compiled stylesheet inlined — the cheap way to LOOK at a
 * document (open the file) instead of booting a dev server to click through to
 * it. `<Image>` sources are emitted as `file://` paths, so the real screenshots
 * show up when the page is opened locally.
 *
 * Outside a browser that graph needs two things, which this script provides:
 * DOM globals (jsdom) and vite-powered module loading (tsx + `~` alias).
 */
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
const file = args.find(
  (arg, index) => !arg.startsWith("--") && (outIndex === -1 || index !== outIndex + 1),
);
if (!file || (outIndex !== -1 && !outFile)) {
  console.error("Usage: node apps/web/scripts/lint-plan.mjs <plan.mdx> [--out <file.html>]");
  process.exit(2);
}
const planPath = NodePath.resolve(process.cwd(), file);
const planDir = NodePath.dirname(planPath);
const source = NodeFS.readFileSync(planPath, "utf8");

// DOM globals for mermaid.parse and the wireframe sanitiser dry-run.
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

/** The rendered document as a standalone page: the app's compiled stylesheet
 * inlined, and the same root wrapper + width variable `MdxPlanRenderer` mounts
 * under, so blocks get the prose measure and the wide-block bleed they have
 * in-app. */
async function writeStandalonePage(html, target) {
  const css = (await server.transformRequest("/src/index.css?direct"))?.code ?? "";
  const page = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NodePath.basename(planPath)}</title>
<style>${css}</style>
</head>
<body class="bg-background text-foreground" style="--timeline-available-width: 1180px">
<div data-plan-root class="plan-mdx mx-auto max-w-4xl px-6 py-5">${html}</div>
</body>
</html>
`;
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, page);
  const shown = NodePath.relative(process.cwd(), target);
  console.log(`wrote ${shown.startsWith("..") ? target : shown} (${page.length} bytes)`);
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
      await writeStandalonePage(render.html, NodePath.resolve(process.cwd(), outFile));
    }
  }
  console.log(formatFindings(findings, NodePath.relative(process.cwd(), planPath)));
  failed = findings.some((finding) => finding.severity === "error");
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
