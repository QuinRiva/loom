import { describe, expect, it } from "vite-plus/test";

import { GOAL_TOOL_DEFS, WORKSTREAM_TOOL_DEFS } from "./providerToolDefs.ts";

// loom: forkFrom (D2) — the tool schemas must NOT unconditionally require
// `role`, because a fork call MUST omit it (identity is inherited; the handler
// rejects role + forkFrom). A schema that required role would make every fork
// request non-conforming, so the feature would be unusable through the tools.
const defByName = (name: string) => {
  const def = WORKSTREAM_TOOL_DEFS.find((entry) => entry.name === name);
  if (def === undefined) throw new Error(`missing tool def ${name}`);
  return def;
};

const goalDefByName = (name: string) => {
  const def = GOAL_TOOL_DEFS.find((entry) => entry.name === name);
  if (def === undefined) throw new Error(`missing goal tool def ${name}`);
  return def;
};

const spawnParams = defByName("workstream_spawn").parameters as {
  readonly required: ReadonlyArray<string>;
  readonly properties: Record<string, unknown>;
};
const scaffoldParams = defByName("workstream_scaffold").parameters as {
  readonly properties: {
    readonly nodes: {
      readonly items: {
        readonly required: ReadonlyArray<string>;
        readonly properties: Record<string, unknown>;
      };
    };
  };
};

describe("workstream tool-def forkFrom contract", () => {
  it("does not unconditionally require role on workstream_spawn (fork calls omit it)", () => {
    expect(spawnParams.required).not.toContain("role");
    expect(spawnParams.required).toContain("purpose");
    expect(spawnParams.required).toContain("title");
  });

  it("exposes forkFrom on workstream_spawn", () => {
    expect(spawnParams.properties).toHaveProperty("forkFrom");
  });

  it("does not unconditionally require role on a scaffold node (fork nodes omit it)", () => {
    const nodeReq = scaffoldParams.properties.nodes.items.required;
    expect(nodeReq).not.toContain("role");
    expect(nodeReq).toContain("key");
    expect(nodeReq).toContain("title");
    expect(nodeReq).toContain("purpose");
  });

  it("exposes forkFrom on a scaffold node", () => {
    expect(scaffoldParams.properties.nodes.items.properties).toHaveProperty("forkFrom");
  });
});

// loom: kickoff-artefact contract alignment. spawn.brief is the canonical
// recipient contract for a child kickoff; workstream_brief.markdown and
// workstream_prompt.message (unstarted-node landing) and scaffold nodes'
// forkFrom must REFERENCE the canonical field and NOT restate its shared
// clauses (rubric principle 7), so a correction to the canonical text cannot
// leave a stale summary teaching different semantics on another surface. The
// forkFrom assertion pins this concretely: the shared identity/blockedBy/gate
// clauses live only on spawn.forkFrom, so their reappearance here is drift.
describe("kickoff-artefact contract alignment", () => {
  const descOf = (props: Record<string, unknown>, field: string): string =>
    (props[field] as { readonly description: string }).description;

  const briefMarkdown = descOf(
    (defByName("workstream_brief").parameters as { readonly properties: Record<string, unknown> })
      .properties,
    "markdown",
  );
  const promptMessage = descOf(
    (defByName("workstream_prompt").parameters as { readonly properties: Record<string, unknown> })
      .properties,
    "message",
  );
  const spawnBrief = descOf(spawnParams.properties, "brief");
  const scaffoldForkFrom = descOf(scaffoldParams.properties.nodes.items.properties, "forkFrom");

  it("references the canonical spawn.brief from the other kickoff-authoring surfaces", () => {
    expect(briefMarkdown).toContain("workstream_spawn's brief");
    expect(promptMessage).toContain("workstream_spawn's brief");
  });

  it("references spawn.forkFrom from scaffold nodes without restating its shared clauses", () => {
    expect(scaffoldForkFrom).toContain("workstream_spawn's forkFrom");
    // Shared clauses belong only to the canonical; scaffold owns just its own
    // deltas (key/thread source refs, fork-of-fork, staging). A restatement of
    // identity-inheritance, blockedBy, or gate here is the principle-7 drift.
    expect(scaffoldForkFrom).not.toMatch(/blockedBy/);
    expect(scaffoldForkFrom).not.toMatch(/gate/i);
    expect(scaffoldForkFrom).not.toMatch(/identity|inherit/i);
  });

  it("does not reintroduce the context-free / role-override over-claims the review corrected", () => {
    for (const text of [spawnBrief, briefMarkdown]) {
      expect(text).not.toMatch(/context-free/i);
      expect(text).not.toMatch(/overrides its role/i);
    }
  });
});

describe("goal_handoff tool-def contract", () => {
  const handoffParams = goalDefByName("goal_handoff").parameters as {
    readonly required: ReadonlyArray<string>;
    readonly properties: Record<string, unknown>;
  };

  it("requires title, brief and description", () => {
    expect(handoffParams.required).toContain("title");
    expect(handoffParams.required).toContain("brief");
    expect(handoffParams.required).toContain("description");
  });

  it("no longer exposes threadTitle", () => {
    expect(handoffParams.properties).not.toHaveProperty("threadTitle");
  });
});
