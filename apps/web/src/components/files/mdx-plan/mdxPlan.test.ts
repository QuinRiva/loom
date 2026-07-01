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

const entryFor = (tag: string) => PLAN_BLOCKS.find((entry) => entry.tag === tag)!;
const codeEntry = entryFor("Code");
const dataModelEntry = entryFor("DataModel");
const roundTrip = (tag: string, data: unknown) =>
  parsePlanBlock(entryFor(tag), serializePlanBlock(entryFor(tag), data));

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

  it("round-trips an Endpoint block (JSON array props; description is prose children, not an attr)", () => {
    const data = {
      method: "POST" as const,
      path: "/api/auth/token",
      summary: "Mint a token",
      params: [{ name: "userId", in: "body" as const, type: "string", required: true }],
      responses: [{ status: "201", description: "Created" }],
    };
    // description is serialized as prose children (dropped by the self-closing
    // serializer), so the attr round-trip covers everything else.
    expect(roundTrip("Endpoint", data)).toEqual({ ...data, method: "POST" });
  });

  it("round-trips a FileTree block", () => {
    const data = {
      title: "Changes",
      entries: [
        { path: "src/a.ts", change: "added" as const, note: "new" },
        { path: "src/b.ts", change: "modified" as const, snippet: "const x = 1\n", language: "ts" },
      ],
    };
    expect(roundTrip("FileTree", data)).toEqual(data);
  });

  it("round-trips an AnnotatedCode block (multiline code + line annotations)", () => {
    const data = {
      filename: "src/token.ts",
      language: "ts",
      code: "function mint() {\n  return sign(payload)\n}\n",
      annotations: [
        { lines: "2", label: "sign", note: "uses the KMS handle" },
        { lines: "1-3", note: "whole body" },
      ],
    };
    expect(roundTrip("AnnotatedCode", data)).toEqual(data);
  });

  it("round-trips a Diagram block (graph wrapped in a `data` attr)", () => {
    const data = {
      caption: "Flow",
      nodes: [
        { id: "a", label: "A", x: 10, y: 20 },
        { id: "b", label: "B", detail: "detail", x: 80, y: 20 },
      ],
      edges: [{ from: "a", to: "b", label: "go" }],
    };
    expect(roundTrip("Diagram", data)).toEqual(data);
  });

  it("round-trips a QuestionForm block", () => {
    const data = {
      questions: [
        {
          id: "ttl",
          title: "Default TTL?",
          mode: "single" as const,
          options: [
            { id: "s", label: "1h", recommended: true },
            { id: "l", label: "30d", detail: "larger blast radius" },
          ],
        },
        { id: "free", title: "Anything else?", mode: "freeform" as const },
      ],
    };
    expect(roundTrip("QuestionForm", data)).toEqual(data);
  });

  it("round-trips a Json block (json kept as a verbatim string)", () => {
    const data = {
      title: "Payload",
      json: '{\n  "sub": "user_01",\n  "roles": ["member"]\n}',
      collapsedDepth: 2,
    };
    expect(roundTrip("Json", data)).toEqual(data);
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
