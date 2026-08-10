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

// loom: child-prompt dedup P1. spawn.brief is the canonical statement of what a
// child ALREADY inherits, so an orchestrator can brief the task-specific delta
// instead of re-transmitting standing context. Two failure tails must stay
// guarded, and the conditional surfaces must not be re-flattened into universal
// claims: a free-text role has no overlay (roleOverlay.loadRoleOverlay returns
// undefined) and a goal-less thread gets no goal/task-tree block
// (ProviderCommandReactor.buildGoalSystemPrompt returns undefined), so a
// universal phrasing would tell the orchestrator to omit context the child never
// receives.
describe("inherited-surfaces brief contract (P1)", () => {
  const spawnBrief = (spawnParams.properties.brief as { readonly description: string }).description;

  it("frames the brief as the task-specific delta over named inherited surfaces", () => {
    expect(spawnBrief).toMatch(/task-specific delta/i);
    expect(spawnBrief).toMatch(/AGENTS\.md/);
  });

  it("marks the conditional surfaces as conditional, not universal", () => {
    expect(spawnBrief).toMatch(/conditional/i);
    expect(spawnBrief).toMatch(/free-text role/i);
    expect(spawnBrief).toMatch(/goal-less/i);
  });

  it("guards the under-specification tail as well as over-transmission", () => {
    expect(spawnBrief).toMatch(/still belongs in the brief/i);
    expect(spawnBrief).toMatch(/absent from, stale in, or inapplicable/i);
  });
});

// loom: child-prompt dedup P2a. workstream_submit's DESCRIPTION is the single
// contract of record for the completion protocol: it is guaranteed present in
// every request of every thread that can submit, whereas the kickoff wrapper's
// salience decays and ambient guideline bullets are paid by every turn that
// never submits. The three tools below therefore ship NO guidelines; a returning
// paraphrase is drift by construction (rubric principle 7 + the ambient-cost
// rule), so it fails here.
describe("completion protocol has one contract of record (P2a)", () => {
  const submitDef = defByName("workstream_submit");

  it("keeps outcome routing AND the result-echo duty on the submit description", () => {
    expect(submitDef.description).toMatch(/never set your own lane at completion/i);
    expect(submitDef.description).toMatch(/echoes the routing decision/i);
    expect(submitDef.description).toMatch(/needs_human/);
  });

  it("ships no ambient paraphrase of the protocol on any of the three tools", () => {
    for (const name of [
      "workstream_submit",
      "workstream_set_lane",
      "workstream_request_attention",
    ]) {
      expect(defByName(name).promptGuidelines).toEqual([]);
    }
  });
});

describe("notify_thread tool-def contract", () => {
  const notifyDef = defByName("notify_thread");
  const notifyParams = notifyDef.parameters as {
    readonly required: ReadonlyArray<string>;
    readonly properties: Record<string, { readonly description?: string }>;
  };

  // Collect every shipped string on the def for the style drift guard.
  const notifyStrings = [
    notifyDef.description,
    notifyDef.promptSnippet ?? "",
    ...(notifyDef.promptGuidelines ?? []),
    notifyDef.fallbackText ?? "",
    ...Object.values(notifyParams.properties).map((property) => property.description ?? ""),
  ];

  it("exists, requires only message, and exposes threadId + name", () => {
    expect(notifyParams.required).toEqual(["message"]);
    expect(notifyParams.properties).toHaveProperty("threadId");
    expect(notifyParams.properties).toHaveProperty("name");
    expect(notifyDef.fallbackText).toBe("Notification accepted.");
  });

  it("states the exactly-one-of id/name contract in prose on both params", () => {
    expect(notifyParams.properties.threadId?.description).toMatch(/both is rejected|rejected/i);
    expect(notifyParams.properties.name?.description).toMatch(/rejected/i);
  });

  // Cheap style drift guard (plan §5): the tool text must ship with NO em
  // dashes, even though the plan document's prose uses them.
  it("ships no em dash in any notify_thread string", () => {
    for (const text of notifyStrings) {
      expect(text).not.toContain("\u2014");
    }
  });

  it("routes wants-an-answer / covert-delegation to the named sibling tools", () => {
    expect(notifyDef.description).toMatch(/consult_thread/);
    expect(notifyDef.description).toMatch(/workstream_prompt/);
    expect(notifyParams.properties.message?.description).toMatch(
      /never re-task, steer, or covertly delegate/,
    );
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
