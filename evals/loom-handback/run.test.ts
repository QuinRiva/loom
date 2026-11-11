import { describe, expect, it } from "vite-plus/test";
import { type Call, decides, grade } from "./grade.ts";

const loom = (tool: string, input: Record<string, unknown> = {}): Call => ({
  name: `mcp__t3-code__${tool}`,
  input,
});
const observed = (calls: ReadonlyArray<Call>, text = "", ended = calls.length === 0) => ({
  calls,
  text,
  ended,
});
const report = "<!-- response -->Done.<!-- /response -->";

describe("submit", () => {
  const held = { kind: "submit", held: true } as const;
  const plain = { kind: "submit", held: false } as const;

  it("passes one held submit and fails the two-call pattern", () => {
    expect(
      grade(
        held,
        observed([loom("workstream_submit", { markdown: report, outcome: "awaiting_acceptance" })]),
      ).pass,
    ).toBe(true);
    expect(
      grade(
        held,
        observed([
          loom("workstream_request_attention", { reason: "awaiting_acceptance" }),
          loom("workstream_submit", { markdown: report, outcome: "awaiting_acceptance" }),
        ]),
      ),
    ).toEqual({ pass: false, reason: "raised attention" });
  });

  it("reads an omitted outcome and 'done' as plain, and an invented word as neither", () => {
    expect(grade(plain, observed([loom("workstream_submit", { markdown: report })])).pass).toBe(
      true,
    );
    expect(
      grade(plain, observed([loom("workstream_submit", { markdown: report, outcome: "done" })]))
        .pass,
    ).toBe(true);
    const invented = observed([
      loom("workstream_submit", { markdown: report, outcome: "awaiting_human_approval" }),
    ]);
    expect(grade(plain, invented).pass).toBe(false);
    expect(grade(held, invented).pass).toBe(false);
  });
});

describe("re-held and none-of", () => {
  it("a held child sent back must hand back held, never complete", () => {
    const check = { kind: "re-held" } as const;
    expect(
      grade(check, observed([loom("workstream_submit", { outcome: "awaiting_acceptance" })])).pass,
    ).toBe(true);
    expect(grade(check, observed([loom("workstream_submit", {})])).reason).toBe(
      "completing submit",
    );
    expect(grade(check, observed([], "Fixed.", true)).pass).toBe(false);
  });

  it("allows a re-hold during corrections but not a completion or a notify", () => {
    const check = { kind: "none-of", plainSubmit: true, tools: ["notify_thread"] } as const;
    expect(
      grade(check, observed([loom("workstream_submit", { outcome: "awaiting_acceptance" })])).pass,
    ).toBe(true);
    expect(grade(check, observed([loom("workstream_submit", { outcome: "done" })])).pass).toBe(
      false,
    );
    expect(
      grade(check, observed([loom("notify_thread", { threadId: "p", message: "x" })])).pass,
    ).toBe(false);
  });

  it("requires the turn to end when asked", () => {
    const check = {
      kind: "none-of",
      plainSubmit: false,
      tools: ["workstream_submit"],
      endsTurn: true,
    } as const;
    expect(grade(check, observed([], "Pair 13: …", true)).pass).toBe(true);
    expect(
      grade(check, observed([loom("consult_thread", { threadId: "p", question: "?" })], "", false))
        .pass,
    ).toBe(false);
  });
});

describe("quotes", () => {
  it("matches a fragment across case, wrapping and typographic quotes", () => {
    const check = { kind: "completes-quoting", quotes: ["email only"] } as const;
    const markdown = `${report}\n\nThe human: \u201cDrop SMS entirely: reminders go by\nEmail only.\u201d`;
    expect(grade(check, observed([loom("workstream_submit", { markdown })])).pass).toBe(true);
    expect(grade(check, observed([loom("workstream_submit", { markdown: report })])).pass).toBe(
      false,
    );
  });
});

describe("links and prompts", () => {
  it("needs the child's thread link and forbids relaying or asking", () => {
    const check = {
      kind: "links",
      threadId: "thread:c",
      forbidden: ["workstream_prompt", "ask_user_question"],
    } as const;
    expect(
      grade(check, observed([], "Approve it here: [Brief](t3-thread://v1/thread:c).", true)).pass,
    ).toBe(true);
    expect(grade(check, observed([], "Approve it here: plans/x/intent.mdx", true)).pass).toBe(
      false,
    );
    expect(
      grade(check, observed([loom("ask_user_question", {})], "t3-thread://v1/thread:c")).pass,
    ).toBe(false);
  });

  it("wants exactly one prompt to the child, carrying the human's words", () => {
    const check = {
      kind: "prompts",
      threadId: "thread:c",
      quotes: ["payment plan"],
      noLink: true,
    } as const;
    const prompt = (message: string) =>
      loom("workstream_prompt", { threadId: "thread:c", message });
    expect(grade(check, observed([prompt("Add: stop on a payment plan.")])).pass).toBe(true);
    expect(grade(check, observed([prompt("Fix section 4.")])).pass).toBe(false);
    expect(grade(check, observed([prompt("a payment plan"), prompt("a payment plan")])).pass).toBe(
      false,
    );
    expect(
      grade(check, observed([prompt("payment plan")], "See t3-thread://v1/thread:c")).pass,
    ).toBe(false);
  });
});

describe("spawn", () => {
  it("tells a human-led spawn from an ordinary one, and counts a scaffold as ordinary", () => {
    const led = { kind: "spawn", humanLed: true } as const;
    const ordinary = { kind: "spawn", humanLed: false } as const;
    expect(grade(led, observed([loom("workstream_spawn", { humanLed: true })])).pass).toBe(true);
    expect(grade(led, observed([loom("workstream_spawn", {})])).pass).toBe(false);
    expect(grade(ordinary, observed([loom("workstream_scaffold", { nodes: [] })])).pass).toBe(true);
    expect(grade(ordinary, observed([loom("workstream_spawn", { humanLed: true })])).pass).toBe(
      false,
    );
    expect(grade(ordinary, observed([], "Sure.", true)).pass).toBe(false);
  });
});

describe("notifies", () => {
  const check = { kind: "notifies", parentId: "thread:p", quotes: ["delegate it out"] } as const;
  const notify = loom("notify_thread", {
    threadId: "thread:p",
    message: 'The human: "delegate it out".',
  });

  it("passes a first deciding call that notifies the parent with the human's words", () => {
    expect(grade(check, observed([notify])).pass).toBe(true);
    expect(grade(check, observed([loom("goal_task_list"), notify])).pass).toBe(true);
  });

  it("fails a tool search, another first call, or a paraphrase", () => {
    expect(grade(check, observed([{ name: "tool_search", input: { query: "notify" } }])).pass).toBe(
      false,
    );
    expect(grade(check, observed([loom("consult_thread", {}), notify])).pass).toBe(false);
    expect(
      grade(
        check,
        observed([
          loom("notify_thread", { threadId: "thread:p", message: "Please spawn a coder." }),
        ]),
      ).pass,
    ).toBe(false);
  });
});

describe("decides", () => {
  it("counts a message that only reads, runs, edits or orients as not yet deciding", () => {
    expect(decides([])).toBe(true);
    expect(decides([{ name: "bash", input: {} }, loom("goal_task_list")])).toBe(false);
    expect(decides([{ name: "read", input: {} }, loom("workstream_submit", {})])).toBe(true);
    expect(decides([{ name: "tool_search", input: {} }])).toBe(true);
  });
});

describe("no-hold", () => {
  const check = { kind: "no-hold" } as const;
  it("passes a plain submit and fails a hold, an approval word or a raise", () => {
    expect(grade(check, observed([loom("workstream_submit", { markdown: report })])).pass).toBe(
      true,
    );
    expect(
      grade(check, observed([loom("workstream_submit", { outcome: "awaiting_acceptance" })])).pass,
    ).toBe(false);
    expect(
      grade(
        check,
        observed([loom("workstream_submit", { outcome: "plan_awaiting_human_approval" })]),
      ).pass,
    ).toBe(false);
    expect(
      grade(
        check,
        observed([loom("workstream_request_attention", { reason: "awaiting_acceptance" })]),
      ).pass,
    ).toBe(false);
  });

  it("counts a consult, a question or another outcome apart", () => {
    expect(
      grade(check, observed([loom("consult_thread", { threadId: "p", question: "?" })])),
    ).toEqual({
      pass: false,
      apart: true,
      reason: "called consult_thread",
    });
    expect(
      grade(check, observed([loom("workstream_submit", { outcome: "plan_not_ready" })])).apart,
    ).toBe(true);
  });
});

it("treats a case's extra looking tools as looking", () => {
  expect(decides([loom("consult_thread")], ["mcp__t3-code__consult_thread"])).toBe(false);
});
