// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { compilePlanMdx } from "./MdxPlanRenderer";
import { lintPlanSource } from "./planLint";

/**
 * Contract test for the plan validator — authoring agents rely on it to gate
 * plans before handing them to the user, so each check class earns one case.
 */

const errors = async (source: string) =>
  (await lintPlanSource(source)).filter((f) => f.severity === "error");
const errorText = async (source: string) => (await errors(source)).map((f) => f.message).join("\n");
const warningText = async (source: string) =>
  (await lintPlanSource(source))
    .filter((f) => f.severity === "warning")
    .map((f) => f.message)
    .join("\n");

describe("lintPlanSource", () => {
  it("passes a valid plan with no findings", async () => {
    const source = [
      "# Plan",
      "",
      '<Callout tone="info">All good.</Callout>',
      "",
      '<Table columns={["a", "b"]} rows={[["1", "2"]]} />',
    ].join("\n");
    expect(await lintPlanSource(source)).toEqual([]);
  });

  it("rejects unknown tags with a suggestion and position", async () => {
    const [finding] = await errors("# t\n\n<Tabs>x</Tabs>\n");
    expect(finding?.message).toContain("Unknown tag <Tabs>");
    expect(finding?.message).toContain("<TabsBlock>");
    expect(finding?.line).toBe(3);
  });

  it("rejects MDX syntax errors with a friendly hint", async () => {
    expect(await errorText("# t\n\n<Code code={'x'}\n")).toContain("Hint");
  });

  it("rejects raw expressions and spread attributes", async () => {
    expect(await errorText("# t\n\n{1 + 1}\n")).toContain("mdxFlowExpression");
    expect(await errorText('<Code {...{"code": "x"}} />')).toContain("spread attribute");
  });

  it("reports zod prop failures with paths", async () => {
    expect(await errorText('<Callout tone="banana">x</Callout>')).toContain("tone");
  });

  it("warns on unknown props (silently stripped by the renderer)", async () => {
    expect(await warningText('<Code code="x" langauge="ts" />')).toContain('"langauge"');
  });

  it("checks canvas reference integrity", async () => {
    const board = (inner: string) =>
      `<DesignBoard title="b">\n  <Artboard id="a1" x={0} y={0} html="<p>x</p>" />\n  ${inner}\n</DesignBoard>`;
    expect(await errorText(board('<Connector from="a1" to="ghost" />'))).toContain('"ghost"');
    // dangling targetId without x/y fallback = invisible = error
    expect(await errors(board('<Annotation targetId="ghost">n</Annotation>'))).toHaveLength(1);
    // with fallback coordinates it degrades to a warning
    expect(
      await errors(board('<Annotation targetId="ghost" x={5} y={5}>n</Annotation>')),
    ).toHaveLength(0);
    expect(await lintPlanSource(board('<Connector from="a1" to="a1" />'))).toEqual([]);
  });

  it("checks Diagram edge endpoints and duplicate block ids", async () => {
    expect(
      await errorText(
        '<Diagram nodes={[{ "id": "a", "label": "A" }]} edges={[{ "from": "a", "to": "b" }]} />',
      ),
    ).toContain('"b"');
    expect(await errorText('<Callout id="x">1</Callout>\n\n<Callout id="x">2</Callout>')).toContain(
      'Duplicate block id "x"',
    );
  });

  it("checks must-parse string props (Json, OpenApi, Mermaid)", async () => {
    expect(await errorText('<Json json="{ nope" />')).toContain("not valid JSON");
    expect(await errorText('<OpenApi spec={"openapi: 3.0.0\\npaths: {}"} />')).toContain("YAML");
    expect(await errorText('<Mermaid source={"flowchart TD\\n  A --> ==>>"} />')).toContain(
      "failed to parse",
    );
    expect(await warningText('<Mermaid source="" />')).toContain("empty");
    expect(
      await lintPlanSource('<Mermaid source={"flowchart LR\\n  A[Hi] --> B[There]"} />'),
    ).toEqual([]);
  });

  it("enforces nesting rules and warns on phantom container children", async () => {
    expect(await errorText('<Tab label="t">x</Tab>')).toContain("direct child");
    expect(
      await warningText('<TabsBlock>\n  <Callout tone="info">not a tab</Callout>\n</TabsBlock>'),
    ).toContain("phantom");
  });

  it("warns on ragged tables and sanitiser-stripped wireframe HTML", async () => {
    expect(await warningText('<Table columns={["a", "b"]} rows={[["1"]]} />')).toContain("ragged");
    const stripped = await warningText(
      '<Screen html={"<div style=\\"position:fixed\\"><button onclick=\\"x()\\">b</button></div>"} />',
    );
    expect(stripped).toContain("style attribute removed");
    expect(stripped).toContain("onclick");
  });
});

describe("remark guard (renderer)", () => {
  it("rejects spread attributes at compile time", async () => {
    await expect(compilePlanMdx('<Code {...{"code": "x"}} />')).rejects.toThrow(/spread/i);
  });
});
