// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { lintPlanSource } from "../planLint";
import { PLAN_BLOCKS, parsePlanBlock, serializePlanBlock } from "../registry";
import { mermaidBlock, renderMermaidSvg, TONE_THEME_CSS } from "./mermaid";

/**
 * Vocabulary v2 `<Mermaid>`: node tones reach the rendered SVG through Mermaid's
 * own class syntax + our `themeCSS`, the legend decodes them, and an unknown
 * `tone-*` class is a lint warning. The render case drives the real mermaid
 * runtime (jsdom has no layout, so text measurement is stubbed) over the graph
 * the fan-in recap draws.
 */

const GRAPH = [
  "flowchart LR",
  '  R["researcher · done"]:::tone-success',
  '  W["writer<br/>done · unmerged"]:::tone-warning',
  '  C["coder · ready, blocked"]:::tone-neutral',
  "  W --> R",
  "  C -->|waits for merge| W",
  "  class W tone-warning",
  "  linkStyle 1 stroke:tone-risk,color:tone-risk",
].join("\n");

describe("Mermaid — tones, look, legend", () => {
  it("emits one fill/stroke rule per palette tone, keyed to the node class", () => {
    for (const tone of ["neutral", "info", "success", "warning", "risk", "accent"]) {
      expect(TONE_THEME_CSS).toContain(
        `.node.tone-${tone} rect,.node.tone-${tone} polygon,.node.tone-${tone} circle`,
      );
      expect(TONE_THEME_CSS).toContain(
        `{fill:var(--plan-tone-${tone}-soft);stroke:var(--plan-tone-${tone});`,
      );
      expect(TONE_THEME_CSS).toContain(`.rough-node.tone-${tone} path{`);
    }
  });

  it("renders toned nodes with the tone rules inside the SVG's own <style>", async () => {
    const proto = SVGElement.prototype as unknown as Record<string, unknown>;
    proto.getBBox = () => ({ x: 0, y: 0, width: 120, height: 20 });
    proto.getComputedTextLength = () => 120;
    try {
      const svg = await renderMermaidSvg(GRAPH, false, "classic");
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const classOf = (id: string) =>
        doc.querySelector(`[id*="flowchart-${id}-"]`)!.getAttribute("class");
      expect(classOf("R")).toContain("node default tone-success");
      expect(classOf("W")).toContain("tone-warning");
      expect(classOf("C")).toContain("tone-neutral");
      // Scoped to this svg's id by mermaid, and not stripped by either sanitiser.
      const id = doc.documentElement.id;
      expect(doc.querySelector("style")!.textContent).toContain(
        `#${id} .node.tone-success rect,#${id} .node.tone-success polygon`,
      );
      expect(doc.querySelector('[data-look="classic"]')).not.toBeNull();
      // A two-line label is two rows, the second styled as the status line.
      expect(doc.querySelectorAll('[id*="flowchart-W-"] tspan.row')).toHaveLength(2);
      // Only an authored <br/> marks the status line — a Mermaid auto-wrap renders
      // identical rows and must stay one style.
      expect(doc.querySelector('[id*="flowchart-W-"]')!.classList).toContain("plan-status");
      expect(doc.querySelector('[id*="flowchart-C-"]')!.classList).not.toContain("plan-status");
      // An edge toned by name gets the palette variable on its path, label and arrowhead.
      expect(doc.querySelector('[id$="-L_C_W_0"]')!.getAttribute("style")).toContain(
        "stroke:var(--plan-tone-risk)",
      );
      expect(svg).not.toMatch(/(?:stroke|fill|color)(?::|=")tone-/);
      const rough = await renderMermaidSvg(GRAPH, true, "handDrawn");
      expect(rough).toContain('class="rough-node default tone-success"');
    } finally {
      delete proto.getBBox;
      delete proto.getComputedTextLength;
    }
  });

  it("renders the legend under the figure and round-trips look + legend", () => {
    const legend = [
      { tone: "neutral" as const, label: "written dependency (blockedBy)" },
      { tone: "risk" as const, label: "the unwritten edge" },
    ];
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      createElement(mermaidBlock.Read, {
        data: { source: GRAPH, caption: "Cap", legend },
        blockId: "m",
      }),
    );
    const items = [...host.querySelectorAll(".plan-mermaid-legend > li")];
    expect(items.map((li) => li.textContent)).toEqual(legend.map((entry) => entry.label));
    expect(items[1]!.querySelector<HTMLElement>(".plan-mermaid-swatch")!.style.borderColor).toBe(
      "var(--plan-tone-risk)",
    );
    // The legend sits above the caption.
    expect(host.querySelector(".plan-mermaid-legend + figcaption")).not.toBeNull();

    const entry = PLAN_BLOCKS.find((block) => block.tag === "Mermaid")!;
    const data = { source: GRAPH, look: "handDrawn", legend };
    expect(parsePlanBlock(entry, serializePlanBlock(entry, data))).toEqual(data);
  });

  it("warns on a tone-* class outside the palette, unless the author defines it", async () => {
    const lint = async (source: string) =>
      (await lintPlanSource(`<Mermaid source={${JSON.stringify(source)}} />`))
        .filter((finding) => finding.severity === "warning")
        .map((finding) => finding.message)
        .join("\n");
    expect(
      await lint(
        "flowchart LR\n  A:::tone-red --> B\n  class B tone-gold\n  linkStyle 0 stroke:tone-pink",
      ),
    ).toMatch(/"tone-red"[\s\S]*"tone-gold"[\s\S]*"tone-pink"/);
    expect(await lint(GRAPH)).not.toContain("palette tone");
    expect(
      await lint("flowchart LR\n  A:::tone-custom --> B\n  classDef tone-custom fill:#fff"),
    ).not.toContain("palette tone");
  });
});
