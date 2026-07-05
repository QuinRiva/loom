#!/usr/bin/env node
/**
 * Headless CLI for the MDX plan validator (`src/components/files/mdx-plan/planLint.ts`).
 *
 *   node apps/web/scripts/lint-plan.mjs plans/<slug>/plan.mdx
 *
 * Exits non-zero when the plan has errors (would break/degrade the render);
 * warnings (silent degradation) are reported but do not fail the run.
 *
 * The validator core lives in the renderer's own module graph (registry, zod
 * schemas, sanitiser, mermaid) so it cannot drift — this script provides the
 * two things that graph needs outside a browser: DOM globals (jsdom) and
 * vite-powered module loading (tsx + `~` alias resolution).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { JSDOM } from "jsdom";
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

let failed = false;
try {
  const { lintPlanSource, formatFindings } = await server.ssrLoadModule(
    "/src/components/files/mdx-plan/planLint.ts",
  );
  const findings = await lintPlanSource(source);
  console.log(formatFindings(findings, NodePath.relative(process.cwd(), planPath)));
  failed = findings.some((finding) => finding.severity === "error");
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
