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
  /** Calls made before the deciding message, which a case answered rather than graded. */
  readonly prior?: ReadonlyArray<Call>;
  /** The case's own looking calls, which do not decide even beside a call that does. */
  readonly looking?: ReadonlyArray<string>;
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

/** pi's own tools; any other unprefixed name is a Loom tool called without its server prefix. */
const NATIVE = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "sign_document",
  "tool_search",
  "bg_start",
  "bg_wait",
]);

/**
 * A Loom tool called by its bare name (`notify_thread`), which pi answers "not found" and the model
 * then retries, read as the Loom tool it reaches for.
 */
const canonical = (calls: ReadonlyArray<Call>): ReadonlyArray<Call> =>
  calls.map((call) =>
    call.name.startsWith(LOOM) || NATIVE.has(call.name) ? call : { ...call, name: loom(call.name) },
  );

/** Git subcommands that only read. With `GIT_LISTS`, every other one counts as changing the repository. */
const GIT_READS = new Set(
  "annotate blame cat-file cherry describe diff diff-tree for-each-ref grep help log ls-files ls-tree merge-base name-rev range-diff reflog rev-list rev-parse shortlog show show-ref status version whatchanged".split(
    " ",
  ),
);
/** Subcommands that list when their first argument (empty when absent) matches. */
const GIT_LISTS: Readonly<Record<string, RegExp>> = {
  branch:
    /^$|^(-[alrv]+|--(all|contains|format|list|merged|no-merged|points-at|remotes|show-current|sort|verbose)\b.*)$/,
  tag: /^$|^(-l|-n\d*|--(contains|list|points-at|sort)\b.*)$/,
  remote: /^$|^(-v|show|get-url)$/,
  stash: /^(list|show)$/,
  config: /^(--get\S*|--list|-l|get|list)$/,
  worktree: /^list$/,
};
/** Words a command may follow: wrappers and the tools that run another command. */
const RUNS_NEXT = new Set([
  "sudo",
  "env",
  "time",
  "nohup",
  "command",
  "xargs",
  "-exec",
  "-execdir",
]);
const scratch = (path: string) => /^\/(tmp|dev)\//.test(path);
const WRITE_API =
  /\b(writeFileSync|appendFileSync|writeFile|appendFile|write_text|write_bytes)\b|\bopen\([^)]*,\s*["'][wax]/;

/**
 * The part of a shell command that changes a file or the repository, or null when it only reads.
 * Decided from the command's text: a git subcommand outside the reading ones, an in-place `sed` or
 * `perl`, a command that creates, moves or removes, a redirect or `tee` to a path outside `/tmp`
 * and `/dev`, or a script that opens a file for writing. `run.test.ts` pins the list.
 */
export const shellWrite = (command: string): string | null => {
  const api = WRITE_API.exec(command)?.[0];
  if (api !== undefined) return api;
  // A heredoc's body is a script or a file's text, not shell: only the line that opens it is read.
  const shell = command.replaceAll(/(<<-?\s*["']?(\w+)["']?[^\n]*)\n[\s\S]*?\n\s*\2\b/g, "$1");
  const redirect = /(?:^|[^<>&-])\d?>>?\s*([^\s;|&<>]+)/.exec(
    shell.replaceAll(/"[^"]*"|'[^']*'/g, (quoted) =>
      scratch(quoted.slice(1)) ? quoted.slice(1, -1) : "QUOTED",
    ),
  );
  if (redirect && !scratch(redirect[1]!)) return `> ${redirect[1]}`;
  for (const segment of shell.replaceAll(/["'`]/g, " ").split(/&&|\|\||[;|\n()]|\$\(/)) {
    const words = segment.trim().split(/\s+/);
    for (const [index, word] of words.entries()) {
      const rest = words.slice(index + 1);
      const paths = rest.filter((argument) => !argument.startsWith("-"));
      if (word === "git" || word.endsWith("/git")) {
        // The subcommand is the first word that is neither an option nor `-C`/`-c`'s value.
        const at = rest.findIndex(
          (argument, i) => !argument.startsWith("-") && !/^-[Cc]$/.test(rest[i - 1] ?? ""),
        );
        const [subcommand, first] = at < 0 ? [] : rest.slice(at);
        if (
          subcommand !== undefined &&
          !GIT_READS.has(subcommand) &&
          !GIT_LISTS[subcommand]?.test(first ?? "")
        )
          return `git ${subcommand}`;
        break;
      }
      // Only where a command can stand: first in its segment, or after a word that runs the next.
      if (index > 0 && !RUNS_NEXT.has(words[index - 1]!) && !/^\w+=/.test(words[index - 1]!))
        continue;
      if (
        /^g?sed$|^perl$/.test(word) &&
        rest.some((flag) => /^(-[a-zA-Z]*i|--in-place)/.test(flag))
      )
        return `${word} -i`;
      if (
        /^(rm|rmdir|mv|touch|mkdir|chmod|chown|truncate|tee|patch|dd|ed|ex)$/.test(word) &&
        !(paths.length > 0 && paths.every(scratch))
      )
        return word;
      if (/^(cp|ln|install)$/.test(word) && !scratch(paths.at(-1) ?? "")) return word;
    }
  }
  return null;
};

/** What a call writes: pi's `edit` or `write`, or a shell command (`bash`, `bg_start`) that changes something. */
const writeOf = (call: Call) =>
  call.name === "edit" || call.name === "write"
    ? call.name
    : call.name === "bash" || call.name === "bg_start"
      ? shellWrite(String(call.input.command ?? ""))
      : null;

/**
 * Whether a message decides: it ends the turn, or makes a call that is not looking around. Under a
 * `read-only` check a shell command that writes decides too, so the attempt stops at the write.
 */
export const decides = (
  calls: ReadonlyArray<Call>,
  looking: ReadonlyArray<string> = [],
  check?: Check,
) =>
  calls.length === 0 ||
  canonical(calls).some((call) => !LOOKING.has(call.name) && !looking.includes(call.name)) ||
  (check?.kind === "read-only" &&
    calls.some((call) => call.name === "bash" && writeOf(call) !== null));

/** Lower-case, one space, straight quotes: a quote survives re-wrapping and typographic quotes. */
const normalise = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, '"')
    .replaceAll(/\s+/g, " ");

const quotes = (text: unknown, fragments: ReadonlyArray<string>, all = false) => {
  if (typeof text !== "string") return false;
  const found = (fragment: string) => normalise(text).includes(normalise(fragment));
  return all ? fragments.every(found) : fragments.some(found);
};

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
  /** A submit, none of whose markdown repeats the report on file; a notify and no submit is apart. */
  | { readonly kind: "no-repeat"; readonly repeats: (markdown: string) => boolean }
  /** The first deciding Loom call is notify_thread to the parent, quoting one of the fragments (every one with `allQuotes`). */
  | {
      readonly kind: "notifies";
      readonly parentId: string;
      readonly quotes: ReadonlyArray<string>;
      readonly allQuotes?: boolean;
    }
  /** Exactly one document_query_promote, carrying a comment and this `exchangeAt` copied exactly. */
  | { readonly kind: "promotes"; readonly exchangeAt: string }
  /**
   * Nothing in the whole attempt writes (no `edit` or `write`, no shell command that changes a file
   * or the repository), and the turn ends in text quoting one of the fragments.
   */
  | { readonly kind: "read-only"; readonly quotes: ReadonlyArray<string> };

export interface Grade {
  readonly pass: boolean;
  readonly reason: string;
  /** Decided, but neither way: left out of the verdict and counted apart. */
  readonly apart?: true;
}

/** A tool search for notify_thread, or for a way to message or notify a parent or another thread. */
const REACHES_NOTIFY = /notify|messag\w*|\bsend\w*\b.*\b(parent|orchestrator|thread)\b/i;

/** An outcome word that reads as "held for a human's approval". */
const APPROVAL_WORD = /accept|approv|sign.?off|human/i;

const verdict = (pass: boolean, reason: string): Grade => ({ pass, reason });

export const grade = (check: Check, observed: Observed): Grade => {
  const { text, ended, looking = [] } = observed;
  const calls = canonical(observed.calls);
  const prior = canonical(observed.prior ?? []);
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
      // Reaching for notify_thread through tool_search is an attempted notify (model-text §8.1).
      if (
        check.tools.includes("notify_thread") &&
        calls.some(
          (call) => call.name === "tool_search" && REACHES_NOTIFY.test(String(call.input.query)),
        )
      )
        return verdict(false, "reached for notify_thread through tool_search");
      const called = check.tools.find((tool) => named(calls, tool).length > 0);
      if (called !== undefined) return verdict(false, `called ${called}`);
      // A message whose only decision is a search for some other tool has decided nothing yet.
      const deciding = calls.filter(
        (call) => !LOOKING.has(call.name) && !looking.includes(call.name),
      );
      if (deciding.length > 0 && deciding.every((call) => call.name === "tool_search"))
        return { pass: false, apart: true, reason: "searched for a tool" };
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
    case "no-repeat": {
      // A child that tells its parent of the change and never submits is counted apart, not failed.
      if (submits.length === 0)
        return [...prior, ...calls].some((call) => call.name === loom("notify_thread"))
          ? { pass: false, apart: true, reason: "notified the parent, no submit" }
          : verdict(false, "no submit");
      return submits.some((call) => check.repeats(String(call.input.markdown ?? "")))
        ? verdict(false, "repeated the report")
        : verdict(true, "submitted only what changed");
    }
    case "promotes": {
      const promotes = named(calls, "document_query_promote");
      if (promotes.length === 0 && calls.some((call) => call.name === "tool_search"))
        return { pass: false, apart: true, reason: "searched for a tool" };
      if (promotes.length !== 1) return verdict(false, `${promotes.length} promote calls`);
      const { exchangeAt, text: comment } = promotes[0]!.input;
      if (exchangeAt !== check.exchangeAt) return verdict(false, "exchangeAt not copied");
      return typeof comment === "string" && comment.trim() !== ""
        ? verdict(true, "one promote, exchangeAt copied")
        : verdict(false, "empty comment");
    }
    case "read-only": {
      const wrote = [...prior, ...calls].flatMap((call) => {
        const what = writeOf(call);
        return what === null ? [] : [call.name === what ? `called ${what}` : `shell: ${what}`];
      });
      if (wrote.length > 0) return verdict(false, wrote.join(", then "));
      const deciding = calls.filter(
        (call) => !LOOKING.has(call.name) && !looking.includes(call.name),
      );
      if (deciding.length > 0)
        return deciding.every((call) => call.name === "tool_search")
          ? { pass: false, apart: true, reason: "searched for a tool" }
          : verdict(false, `called ${deciding[0]!.name.replace(LOOM, "")}`);
      return quotes(text, check.quotes)
        ? verdict(true, "changed nothing, said the change")
        : verdict(false, "changed nothing, did not say the change");
    }
    case "notifies": {
      const first = calls.find(
        (call) =>
          call.name.startsWith(LOOM) && !LOOKING.has(call.name) && !looking.includes(call.name),
      );
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
      return quotes(first.input.message, check.quotes, check.allQuotes)
        ? verdict(true, "notified the parent, quoting the human")
        : verdict(false, "notified the parent without the human's words");
    }
  }
};
