#!/usr/bin/env node
/**
 * Headless render-health check for an MDX plan/recap — the gate an agent runs
 * before handing a document to a human:
 *
 *   node apps/web/scripts/lint-plan.mjs plans/<slug>/plan.mdx
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

const file = process.argv[2];
if (!file) {
  console.error("Usage: node apps/web/scripts/lint-plan.mjs <plan.mdx>");
  process.exit(2);
}
const planPath = NodePath.resolve(process.cwd(), file);
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
  const [{ compilePlanMdx }, { PLAN_BLOCK_COMPONENTS }, { PlanEagerMountContext }] =
    await Promise.all([
      load("mdxCompileOptions.ts"),
      load("registry.tsx"),
      load("planEagerMount.ts"),
    ]);

  let html;
  try {
    const Content = await compilePlanMdx(mdxSource);
    // Eager mount so lazily-mounted containers (`<Details>`, tabs) materialise
    // their children — the same thing the annotation layer does.
    html = renderToStaticMarkup(
      createElement(
        PlanEagerMountContext.Provider,
        { value: true },
        createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
      ),
    );
  } catch (cause) {
    return [
      {
        severity: "error",
        message: `render threw (the document fails to display): ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    ];
  }

  const counts = {};
  for (const [, type] of html.matchAll(/data-plan-block-type="([^"]+)"/g)) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const rendered = Object.entries(counts)
    .map(([type, count]) => `${type}×${count}`)
    .join(", ");
  console.log(`render: ${html.length} bytes of HTML, blocks mounted: ${rendered || "none"}`);

  // A block whose props its schema rejects at render (e.g. prose children lint
  // cannot see) degrades to an error card instead of throwing; the card carries
  // the reason, so quote it back stripped of markup.
  return [...html.matchAll(/data-plan-block-error="([^"]+)"/g)].map(({ 1: tag, index }) => ({
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
  }));
}

let failed = false;
try {
  const { lintPlanSource, formatFindings } = await server.ssrLoadModule(
    "/src/components/files/mdx-plan/planLint.ts",
  );
  const findings = await lintPlanSource(source);
  // A lint error already breaks the render; rendering would only repeat it.
  if (!findings.some((finding) => finding.severity === "error")) {
    findings.push(...(await renderFindings(source)));
  }
  console.log(formatFindings(findings, NodePath.relative(process.cwd(), planPath)));
  failed = findings.some((finding) => finding.severity === "error");
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
