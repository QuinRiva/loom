import { describe, expect, it } from "vite-plus/test";
import { type Call, decides, grade, shellWrite } from "./grade.ts";

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

it("counts a tool search for notify_thread as an attempted notify", () => {
  const check = { kind: "none-of", plainSubmit: false, tools: ["notify_thread"] } as const;
  const search = (query: string) => observed([{ name: "tool_search", input: { query } }]);
  expect(grade(check, search("notify_thread send message to parent thread")).reason).toBe(
    "reached for notify_thread through tool_search",
  );
  expect(grade(check, search("browser screenshot"))).toEqual({
    pass: false,
    apart: true,
    reason: "searched for a tool",
  });
});

it("reaches for notify_thread through a search for a way to message the parent", () => {
  const check = { kind: "none-of", plainSubmit: false, tools: ["notify_thread"] } as const;
  const search = (query: string) =>
    grade(check, observed([{ name: "tool_search", input: { query } }]));
  expect(search("send a message to my parent thread").pass).toBe(false);
  expect(search("read a pdf").apart).toBe(true);
});

describe("no-repeat", () => {
  const check = {
    kind: "no-repeat",
    repeats: (markdown: string) => markdown.includes("whole report"),
  } as const;
  it("passes a submit of only what changed and fails a resend or no submit", () => {
    expect(
      grade(check, observed([loom("workstream_submit", { markdown: "the rename" })])).pass,
    ).toBe(true);
    expect(
      grade(check, observed([loom("workstream_submit", { markdown: "the whole report" })])).pass,
    ).toBe(false);
    expect(grade(check, observed([], "Done.", true)).reason).toBe("no submit");
  });
});

it("counts a notify with no submit apart in a no-repeat case", () => {
  const check = { kind: "no-repeat", repeats: () => false } as const;
  const notify = loom("notify_thread", { threadId: "p", message: "renamed" });
  expect(
    grade(check, { calls: [], text: "Told my parent.", ended: true, prior: [notify] }),
  ).toEqual({
    pass: false,
    apart: true,
    reason: "notified the parent, no submit",
  });
  expect(
    grade(check, {
      ...observed([loom("workstream_submit", { markdown: "the rename" })]),
      prior: [notify],
    }).pass,
  ).toBe(true);
});

describe("a finished author's report addition", () => {
  const submit = loom("workstream_submit", {
    markdown: "Round 2: SMS on the second reminder only.",
  });
  const looking = ["mcp__t3-code__workstream_submit"];
  const check = {
    kind: "notifies",
    parentId: "thread:p",
    quotes: ["two retries", "second reminder only"],
    allQuotes: true,
  } as const;
  const notify = (message: string) => loom("notify_thread", { threadId: "thread:p", message });

  it("does not decide, alone or beside the hand-over", () => {
    expect(decides([submit], looking)).toBe(false);
    const both = notify('Approved. "Two retries, not three." "SMS on the second reminder only."');
    expect(grade(check, { ...observed([submit, both]), looking }).pass).toBe(true);
    expect(grade(check, observed([submit, both])).reason).toBe("first Loom call workstream_submit");
  });

  it("needs every change quoted when all quotes are required", () => {
    expect(grade(check, observed([notify('Approved. "Two retries, not three."')])).reason).toBe(
      "notified the parent without the human's words",
    );
  });
});

describe("a query thread", () => {
  const at = "2026-11-12T03:14:07.512Z";
  const promotes = { kind: "promotes", exchangeAt: at } as const;
  const readOnly = { kind: "read-only", quotes: ["currency_code"] } as const;
  const bash = (command: string): Call => ({ name: "bash", input: { command } });

  it("promotes once, with the exchange's timestamp copied exactly", () => {
    const promote = (exchangeAt: string, text = "Rename the column.") =>
      loom("document_query_promote", { exchangeAt, text });
    expect(grade(promotes, observed([promote(at)])).pass).toBe(true);
    expect(grade(promotes, observed([promote("latest")])).reason).toBe("exchangeAt not copied");
    expect(grade(promotes, observed([promote(at, " ")])).reason).toBe("empty comment");
    expect(grade(promotes, observed([promote(at), promote(at)])).reason).toBe("2 promote calls");
    expect(grade(promotes, observed([], "Promoted."))).toEqual({
      pass: false,
      reason: "0 promote calls",
    });
    expect(
      grade(promotes, observed([{ name: "tool_search", input: { query: "promote" } }])).apart,
    ).toBe(true);
  });

  it("reads as a write whatever changes a file or the repository", () => {
    for (const command of [
      "git commit -am 'fix(export): name the column currency_code'",
      "cd /home/user/acme-app && git add -A && git commit -m fix",
      "git -C /home/user/acme-app checkout -- apps/api/src/export/csv.ts",
      "git stash",
      "git branch -D feature",
      "git apply <<'EOF'\n--- a/csv.ts\n+++ b/csv.ts\nEOF",
      `sed -i 's/"currency"/"currency_code"/' apps/api/src/export/csv.ts`,
      "sed -E -i.bak s/a/b/ csv.ts",
      "perl -pi -e 's/currency/currency_code/' csv.ts",
      "find . -name '*.ts' -exec sed -i s/a/b/ {} +",
      "cat > apps/api/src/export/csv.ts <<'EOF'\nexport const header = 1;\nEOF",
      'echo "x" >> notes.md',
      'printf x > "$file"',
      "git show 4be19c2:csv.ts | tee csv.ts",
      "rm apps/api/src/export/csv.test.ts",
      "mv csv.ts csv2.ts",
      "cp /tmp/csv.ts apps/api/src/export/csv.ts",
      `python3 - <<'EOF'\nfrom pathlib import Path\nPath("csv.ts").write_text("x")\nEOF`,
      `python3 -c "open('csv.ts', 'w').write('x')"`,
      `node -e "require('fs').writeFileSync('csv.ts', 'x')"`,
      `bash -c "git commit -am fix"`,
    ])
      expect(shellWrite(command), command).not.toBeNull();
  });

  it("reads as looking whatever only reads, scratch files in /tmp included", () => {
    for (const command of [
      "git log --oneline -5",
      "git --no-pager log -L7,7:apps/api/src/export/csv.ts",
      "git -C /home/user/acme-app show 4be19c2 --stat",
      "git status --short && git diff HEAD~1 -- apps/api/src/export/csv.ts",
      "git blame -L 4,7 apps/api/src/export/csv.ts | cat",
      "git branch --show-current; git branch -a; git stash list; git remote -v; git tag -l",
      "git show 4be19c2:apps/api/src/export/csv.ts > /tmp/before.ts && diff /tmp/before.ts apps/api/src/export/csv.ts",
      "sed -n '1,20p' apps/api/src/export/csv.ts",
      "rg -n 'currency' apps/api/src 2>/dev/null | head -20",
      'grep -c "csv.ts" "$PI_SESSION_FILE"',
      `python3 - <<'EOF'\nimport json\nfor line in open("/tmp/x.jsonl"):\n    if len(line) > 3: print(json.loads(line)["type"])\nEOF`,
      "cat apps/api/src/export/csv.ts | nl | sed -n 4,7p",
      "mkdir -p /tmp/cq && cp apps/api/src/export/csv.ts /tmp/cq/",
      "pnpm test apps/api/src/export 2>&1 | tail -5",
      "echo done >&2",
      "git --version",
    ])
      expect(shellWrite(command), command).toBeNull();
  });

  it("fails a reason stated as fact, a bare deflection and an answer that never looked", () => {
    const check = {
      kind: "others-lines",
      owner: ["3fa1c2d", "Dana"],
      own: ["dayAfter", "my change", "did not touch"],
    } as const;
    const looked = { prior: [bash("git log -L16,16:apps/api/src/bank/feed.ts")] };
    const answer = (text: string, prior = looked) =>
      grade(check, { ...observed([], text), ...prior });
    const whose = "The line is not mine: Dana Whitfield wrote it in `3fa1c2d` in July 2025.";
    const mine = "My change was `dayAfter(to)` three lines up, and I did not touch the delay.";
    expect(
      answer(
        `${whose} ${mine} The commit gives no reason. My reading of the code is that it is a throttle.`,
      ).pass,
    ).toBe(true);
    expect(
      answer(
        `${whose} ${mine} It is 1100 ms because the bank allows one request a second and the extra 100 ms is headroom.`,
      ).reason,
    ).toBe("gives a reason with no mark that it is its own reading");
    expect(answer(`${whose} She is the one to ask why.`).reason).toBe(
      "says nothing of its own work",
    );
    expect(answer(`${mine} I can't tell you why it is 1100 ms.`).reason).toBe(
      "does not say whose the lines are",
    );
    expect(answer(`${whose} ${mine} That is a guess.`, { prior: [] }).reason).toBe(
      "answered without looking",
    );
    const commit = bash("git commit -am 'chore: name the delay'");
    expect(answer(`${whose} ${mine} That is a guess.`, { prior: [commit] }).reason).toBe(
      "shell: git commit",
    );
    expect(decides([commit], [], check)).toBe(true);
  });

  it("fails a write anywhere in the attempt, and a shell write ends it", () => {
    const declined = "I can't change files here. The fix is `currency_code` in `COLUMNS`.";
    expect(grade(readOnly, observed([], declined)).pass).toBe(true);
    expect(grade(readOnly, { ...observed([], declined), prior: [bash("git log -3")] }).pass).toBe(
      true,
    );
    expect(grade(readOnly, observed([], "I can't change files here.")).reason).toBe(
      "wrote nothing, answer does not name it",
    );
    const edit = { name: "edit", input: { path: "csv.ts", edits: [] } };
    expect(grade(readOnly, { ...observed([], declined), prior: [edit] })).toEqual({
      pass: false,
      reason: "called edit",
      settled: true,
    });
    const commit = bash("sed -i s/a/b/ csv.ts && git commit -am fix");
    expect(grade(readOnly, { ...observed([], declined), prior: [edit, commit] }).reason).toBe(
      "called edit, then shell: sed -i",
    );
    expect(grade(readOnly, observed([loom("document_query_promote", {})])).reason).toBe(
      "called document_query_promote",
    );
    expect(decides([commit], [], readOnly)).toBe(true);
    expect(decides([commit])).toBe(false);
    expect(decides([edit, bash("git log -3")], [], readOnly)).toBe(false);
  });
});

it("reads a Loom tool called by its bare name as that tool", () => {
  const bare = {
    name: "notify_thread",
    input: { threadId: "thread:p", message: "delegate it out" },
  };
  const none = { kind: "none-of", plainSubmit: false, tools: ["notify_thread"] } as const;
  expect(grade(none, observed([bare])).reason).toBe("called notify_thread");
  const notifies = { kind: "notifies", parentId: "thread:p", quotes: ["delegate it out"] } as const;
  expect(grade(notifies, observed([bare])).pass).toBe(true);
  expect(
    decides([{ name: "workstream_submit", input: {} }], ["mcp__t3-code__workstream_submit"]),
  ).toBe(false);
});
