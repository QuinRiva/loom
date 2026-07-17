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
