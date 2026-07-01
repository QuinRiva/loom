import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { compilePlanMdx } from "./MdxPlanRenderer";
import { PLAN_BLOCK_COMPONENTS, PLAN_BLOCKS, parsePlanBlock, serializePlanBlock } from "./registry";

/**
 * Verifies the MDX-plan vertical: (1) the byte-stable attr round-trip that is the
 * wire contract for authored plans, and (2) the 3-layer security model. This is
 * the high-risk surface (a wrong round-trip silently corrupts authored plans), so
 * it earns a test per AGENTS.md.
 */

const codeEntry = PLAN_BLOCKS.find((entry) => entry.tag === "Code")!;
const dataModelEntry = PLAN_BLOCKS.find((entry) => entry.tag === "DataModel")!;

describe("mdx-plan block round-trip", () => {
  it("round-trips a Code block (multiline string attr)", () => {
    const data = {
      code: "export const x = 1\nconst y = 2\n",
      language: "ts",
      filename: "src/x.ts",
      maxLines: 12,
    };
    expect(parsePlanBlock(codeEntry, serializePlanBlock(codeEntry, data))).toEqual(data);
  });

  it("round-trips a DataModel block (JSON array props, diff fields inline)", () => {
    const data = {
      entities: [
        {
          id: "user",
          name: "User",
          fields: [
            { name: "id", type: "uuid", pk: true },
            { name: "org_id", type: "uuid", fk: "Org.id" },
          ],
        },
        { id: "org", name: "Org", change: "added" as const, fields: [{ name: "id", pk: true }] },
      ],
      relations: [{ from: "org", to: "user", kind: "1-n" as const, label: "members" }],
    };
    expect(parsePlanBlock(dataModelEntry, serializePlanBlock(dataModelEntry, data))).toEqual(data);
  });
});

const GOOD = [
  "# Plan",
  "",
  "Some **bold** prose.",
  "",
  '<DataModel entities={[{ "id": "user", "name": "User", "fields": [{ "name": "id", "pk": true }] }]} />',
  "",
  '<Code language="ts" code={"export const mintToken = 1"} />',
  "",
].join("\n");

describe("mdx-plan security model", () => {
  it("renders good MDX with custom blocks + GFM through the registry", async () => {
    const Content = await compilePlanMdx(GOOD);
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("User");
    expect(html).toContain('data-plan-block-type="data-model"');
    expect(html).toContain("mintToken"); // code body (SSR fallback <pre>)
  });

  it("rejects imports/exports at compile", async () => {
    await expect(compilePlanMdx('import fs from "node:fs"\n\n# hi')).rejects.toThrow();
  });

  it("rejects raw {expression} bodies at compile", async () => {
    await expect(compilePlanMdx("# hi\n\nvalue: {globalThis.location}")).rejects.toThrow();
  });

  it("rejects unknown components (not in the closed registry)", async () => {
    const Content = await compilePlanMdx("<Malicious onClick={1} />");
    expect(() =>
      renderToStaticMarkup(createElement(Content, { components: PLAN_BLOCK_COMPONENTS })),
    ).toThrow();
  });
});
