/**
 * Deterministic grading of the next assistant message after a case's transcript: its tool calls, in
 * order, and its text.
 */
const LOOM = "mcp__t3-code__";
const loom = (tool: string) => `${LOOM}${tool}`;

export interface Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface Observed {
  readonly calls: ReadonlyArray<Call>;
  /** The last message's text. */
  readonly text: string;
  /** The message called no tool: the turn ended. */
  readonly ended: boolean;
}

/**
 * Calls that look around or keep the record without deciding anything: pi's tools that read, run or
 * edit, and the Loom tools that only orient. A message made only of these has not decided yet.
 */
export const LOOKING: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "sign_document",
  ...[
    "workstream_list",
    "goal_task_list",
    "goal_task_add",
    "goal_task_update",
    "goal_tasks_rewrite",
    "set_thread_title",
    "thread_search",
  ].map((tool) => `mcp__t3-code__${tool}`),
]);

/** Whether a message decides: it ends the turn, or makes a call that is not looking around. */
export const decides = (calls: ReadonlyArray<Call>, looking: ReadonlyArray<string> = []) =>
  calls.length === 0 ||
  calls.some((call) => !LOOKING.has(call.name) && !looking.includes(call.name));

/** Lower-case, one space, straight quotes: a quote survives re-wrapping and typographic quotes. */
const normalise = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, '"')
    .replaceAll(/\s+/g, " ");

const quotes = (text: unknown, fragments: ReadonlyArray<string>) =>
  typeof text === "string" &&
  fragments.some((fragment) => normalise(text).includes(normalise(fragment)));

const outcomeOf = (call: Call) =>
  typeof call.input.outcome === "string" ? call.input.outcome.trim() : "";
const isSubmit = (call: Call) => call.name === loom("workstream_submit");
/** A submit that completes the thread: no outcome, or 'done'. */
const isPlainSubmit = (call: Call) => isSubmit(call) && ["", "done"].includes(outcomeOf(call));
const isHeldSubmit = (call: Call) => isSubmit(call) && outcomeOf(call) === "awaiting_acceptance";
const named = (calls: ReadonlyArray<Call>, tool: string) =>
  calls.filter((call) => call.name === loom(tool));

export type Check =
  /** One submit with this outcome kind, and no attention raise. */
  | { readonly kind: "submit"; readonly held: boolean }
  /** A held submit and no completing one. */
  | { readonly kind: "re-held" }
  /** No completing submit (when `plainSubmit`) and none of the named tools; the turn ended (when `endsTurn`). */
  | {
      readonly kind: "none-of";
      readonly plainSubmit: boolean;
      readonly tools: ReadonlyArray<string>;
      readonly endsTurn?: boolean;
    }
  /** A completing submit whose report quotes one of the fragments. */
  | { readonly kind: "completes-quoting"; readonly quotes: ReadonlyArray<string> }
  /** The final text links the thread; none of the named tools is called. */
  | { readonly kind: "links"; readonly threadId: string; readonly forbidden: ReadonlyArray<string> }
  /** Exactly one workstream_prompt, to this child, quoting a fragment when any are given; no link. */
  | {
      readonly kind: "prompts";
      readonly threadId: string;
      readonly quotes?: ReadonlyArray<string>;
      readonly noLink: boolean;
    }
  /** A child created (spawn or scaffold), with `humanLed: true` on a spawn, or on none. */
  | { readonly kind: "spawn"; readonly humanLed: boolean }
  /**
   * No hold on work no human must approve: a plain submit passes; a held submit, an approval word
   * or an `awaiting_acceptance` raise fails; anything else (a consult, a question) is counted apart.
   */
  | { readonly kind: "no-hold" }
  /** The first deciding Loom call is notify_thread to the parent, quoting one of the fragments. */
  | {
      readonly kind: "notifies";
      readonly parentId: string;
      readonly quotes: ReadonlyArray<string>;
    };

export interface Grade {
  readonly pass: boolean;
  readonly reason: string;
  /** Decided, but neither way: left out of the verdict and counted apart. */
  readonly apart?: true;
}

/** An outcome word that reads as "held for a human's approval". */
const APPROVAL_WORD = /accept|approv|sign.?off|human/i;

const verdict = (pass: boolean, reason: string): Grade => ({ pass, reason });

export const grade = (check: Check, { calls, text, ended }: Observed): Grade => {
  const submits = calls.filter(isSubmit);
  const raises = named(calls, "workstream_request_attention");
  switch (check.kind) {
    case "submit": {
      const fits = check.held ? isHeldSubmit : isPlainSubmit;
      if (raises.length > 0) return verdict(false, "raised attention");
      if (submits.length !== 1) return verdict(false, `${submits.length} submits`);
      return fits(submits[0]!)
        ? verdict(true, `submit outcome '${outcomeOf(submits[0]!) || "(none)"}'`)
        : verdict(false, `submit outcome '${outcomeOf(submits[0]!) || "(none)"}'`);
    }
    case "re-held":
      if (submits.some(isPlainSubmit)) return verdict(false, "completing submit");
      return submits.some(isHeldSubmit)
        ? verdict(true, "held submit")
        : verdict(
            false,
            submits.length > 0
              ? `submit outcome '${outcomeOf(submits[0]!)}'`
              : "no awaiting_acceptance submit",
          );
    case "none-of": {
      if (check.plainSubmit && submits.some(isPlainSubmit))
        return verdict(false, "completing submit");
      // Reaching for notify_thread through tool_search is an attempted notify where it is not loaded.
      if (
        check.tools.includes("notify_thread") &&
        calls.some(
          (call) => call.name === "tool_search" && /notify/i.test(String(call.input.query)),
        )
      )
        return verdict(false, "searched for notify_thread");
      const called = check.tools.find((tool) => named(calls, tool).length > 0);
      if (called !== undefined) return verdict(false, `called ${called}`);
      return !check.endsTurn || ended
        ? verdict(true, "none called")
        : verdict(false, `turn not ended: ${calls.at(-1)?.name ?? "no call"}`);
    }
    case "completes-quoting": {
      const plain = submits.filter(isPlainSubmit);
      if (plain.length === 0) return verdict(false, "no completing submit");
      return plain.some((call) => quotes(call.input.markdown, check.quotes))
        ? verdict(true, "completes, report quotes the human")
        : verdict(false, "completes, report does not quote the human");
    }
    case "links": {
      const called = check.forbidden.find((tool) => named(calls, tool).length > 0);
      if (called !== undefined) return verdict(false, `called ${called}`);
      return text.includes(`t3-thread://v1/${check.threadId}`)
        ? verdict(true, "links the child")
        : verdict(false, "no link to the child");
    }
    case "prompts": {
      const prompts = named(calls, "workstream_prompt");
      if (prompts.length !== 1) return verdict(false, `${prompts.length} prompts`);
      const [prompt] = prompts;
      if (prompt!.input.threadId !== check.threadId)
        return verdict(false, "prompted another thread");
      if (check.quotes && !quotes(prompt!.input.message, check.quotes))
        return verdict(false, "prompt does not carry the human's words");
      if (check.noLink && text.includes(`t3-thread://v1/${check.threadId}`))
        return verdict(false, "linked the child to the human");
      return verdict(true, "one prompt to the child");
    }
    case "spawn": {
      const spawns = named(calls, "workstream_spawn");
      if (spawns.length + named(calls, "workstream_scaffold").length === 0)
        return verdict(false, "no spawn");
      const led = spawns.some((call) => call.input.humanLed === true);
      return led === check.humanLed
        ? verdict(true, led ? "spawned humanLed" : "spawned without humanLed")
        : verdict(false, led ? "spawned humanLed" : "spawned without humanLed");
    }
    case "no-hold": {
      const held = submits.find(
        (call) => isHeldSubmit(call) || APPROVAL_WORD.test(outcomeOf(call)),
      );
      if (held !== undefined) return verdict(false, `held: submit outcome '${outcomeOf(held)}'`);
      if (raises.some((call) => call.input.reason === "awaiting_acceptance"))
        return verdict(false, "raised awaiting_acceptance");
      if (submits.some(isPlainSubmit)) return verdict(true, "plain submit");
      const other = submits[0] ?? raises[0] ?? calls.find((call) => !LOOKING.has(call.name));
      return {
        pass: false,
        apart: true,
        reason:
          other === undefined
            ? "ended the turn"
            : isSubmit(other)
              ? `submit outcome '${outcomeOf(other)}'`
              : `called ${other.name.replace(LOOM, "")}`,
      };
    }
    case "notifies": {
      const first = calls.find((call) => call.name.startsWith(LOOM) && !LOOKING.has(call.name));
      if (first === undefined)
        return verdict(
          false,
          calls.some((call) => call.name === "tool_search")
            ? "tool_search, no Loom call"
            : "no Loom call",
        );
      if (first.name !== loom("notify_thread"))
        return verdict(false, `first Loom call ${first.name.slice(LOOM.length)}`);
      if (first.input.threadId !== check.parentId) return verdict(false, "notified another thread");
      return quotes(first.input.message, check.quotes)
        ? verdict(true, "notified the parent, quoting the human")
        : verdict(false, "notified the parent without the human's words");
    }
  }
};
