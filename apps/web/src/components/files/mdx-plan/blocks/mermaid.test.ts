// @vitest-environment jsdom
import { render } from "pele";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { lintPlanSource } from "../planLint";
import { PLAN_BLOCKS, parsePlanBlock, serializePlanBlock } from "../registry";
import { markStatusNodes, mermaidBlock, sanitizeDiagramSvg } from "./mermaid";

/**
 * Node tones reach the SVG as pele node classes (styled in `index.css`), a toned
 * edge's colour is swapped for the palette variable, the legend decodes them,
 * and an unknown `tone-*` class warns.
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

describe("Mermaid — tones, legend", () => {
  it("renders toned nodes, status lines and toned edges through pele", () => {
    const host = document.createElement("div");
    host.append(sanitizeDiagramSvg(render(markStatusNodes(GRAPH)).svg));
    const node = (id: string) => host.querySelector(`.pele-node[data-id="${id}"]`)!.classList;
    expect(node("R")).toContain("tone-success");
    expect(node("W")).toContain("tone-warning");
    expect(node("C")).toContain("tone-neutral");
    // Only an authored <br/> marks the status line; a wrapped label stays one style.
    expect(node("W")).toContain("plan-status");
    expect(node("C")).not.toContain("plan-status");
    expect(host.querySelectorAll('.pele-node[data-id="W"] .pele-label > tspan')).toHaveLength(2);
    // An edge toned by name gets the palette variable on its path, label and arrowhead.
    const edge = host.querySelector('.pele-edge[data-id="L_C_W_0"]')!;
    expect(edge.getAttribute("style")).toContain("stroke:var(--plan-tone-risk)");
    expect(edge.querySelector(".pele-marker")!.getAttribute("fill")).toBe("var(--plan-tone-risk)");
    expect(host.innerHTML).not.toMatch(/(?:stroke|fill|color)(?::|=")tone-/);
  });

  it("renders the legend under the figure and round-trips the legend", () => {
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
    const data = { source: GRAPH, legend };
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
