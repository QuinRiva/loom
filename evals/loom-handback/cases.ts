/**
 * The 19 cases of plans/human-in-child-thread/plan.mdx §5: authored Acme transcripts ending at a
 * decision. Every Loom-produced message in them is built from source, through `world.ts` where the
 * change alters it. No real thread text: `source` names the situation each mirrors.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { routeWorkSubmit } from "@t3tools/shared/workstreamGraph";
import type { ThreadId } from "@t3tools/contracts";

import { workstreamChildPrompt } from "../../apps/server/src/loom/prompt/prose.ts";
import {
  appendWarnings,
  renderSubmitOutcome,
} from "../../apps/server/src/mcp/toolkits/workstream/render.ts";
import { labelledForModel } from "../../packages/provider-pi/src/server/provenance.loom.ts";
import type { Check } from "./grade.ts";
import { engagedChildTools, finishedSubmitResult, heldHandbackNotices } from "./world.ts";

export const REPORTS_DIR = "/home/user/.t3/userdata/workstream-reports";
export const BRIEFS_DIR = "/home/user/.t3/userdata/workstream-briefs";
export const WORKTREE = "/home/user/acme-app";

export interface ToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
  readonly isError?: boolean;
  /** PNGs, base64, returned with the result (pi's `read` of an image). */
  readonly images?: ReadonlyArray<string>;
}

export type Message =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text?: string;
      readonly calls?: ReadonlyArray<ToolCall>;
    };

export interface Case {
  readonly id: string;
  readonly kind: "bad" | "control" | "guard";
  /** The plan's prediction for today's text, made by reading it. */
  readonly base: "fails" | "passes" | "either";
  readonly source: string;
  readonly role: string;
  readonly threadId: string;
  readonly parentId: string | null;
  /** Tools the session profile adds once a person has written to a child. */
  readonly engagedTools: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<Message>;
  readonly check: Check;
  /** Calls answered by the simulator in this case rather than graded as its decision. */
  readonly looking?: ReadonlyArray<string>;
  /** Messages the model may send before it decides, when the default is too few. */
  readonly maxSteps?: number;
}

/** Where pi installs a skill, and its text from this checkout. */
const skillFile = (name: string) => (/\.\w+$/.test(name) ? name : `${name}/SKILL.md`);
export const skillLocation = (name: string) => `/home/user/.pi/agent/skills/${skillFile(name)}`;
const skillText = (name: string) =>
  NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, "../../skills", skillFile(name)),
    "utf8",
  );

const REPO = NodePath.resolve(import.meta.dirname, "../..");

/**
 * The mdx-doc-core check the skills tell an author to run, run on an authored document now, so a
 * transcript shows its real output and the page it renders.
 */
const lintDoc = (relativePath: string, content: string) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-handback-"));
  const file = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
  const out = relativePath.replace(/[^/]+$/, "render.html");
  const command = `bash ${skillLocation("mdx-doc-core/scripts/lint-doc.sh")} ${relativePath} --out ${out} --png`;
  const output = NodeChildProcess.execFileSync(
    "bash",
    [
      NodePath.join(REPO, "skills/mdx-doc-core/scripts/lint-doc.sh"),
      relativePath,
      "--out",
      out,
      "--png",
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const dir = NodePath.dirname(file);
  const look = NodeFS.readdirSync(dir)
    .filter((name) => /^render-\d+\.png$/.test(name))
    .toSorted()
    .map((name): ToolCall => ({
      name: "read",
      input: { path: at(NodePath.join(NodePath.dirname(relativePath), name)) },
      result: "Read image file [image/png]",
      images: [NodeFS.readFileSync(NodePath.join(dir, name)).toString("base64")],
    }));
  NodeFS.rmSync(root, { recursive: true });
  const check: ToolCall = {
    name: "bash",
    input: { command: `cd ${WORKTREE} && ${command}` },
    result: output.trim(),
  };
  return { check, look };
};

const t = (tool: string) => `mcp__t3-code__${tool}`;
const reportPathOf = (id: string) => `${REPORTS_DIR}/${id.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.md`;
const at = (path: string) => `${WORKTREE}/${path}`;

// Author labels, as the pi adapter frames each message.
const authored = (
  text: string,
  loom: { origin?: "kickoff" | "orchestrator" | "control_notice"; humanAuthored?: boolean },
  hasParent: boolean,
): Message => ({
  role: "user",
  text: labelledForModel({
    messageId: "message:eval",
    text,
    createdBy: loom.humanAuthored ? "user" : "agent",
    creationSource: "eval",
    loom,
    hasParent,
  }),
});
const humanInChild = (text: string) => authored(text, { humanAuthored: true }, true);
const humanInRoot = (text: string) => authored(text, { humanAuthored: true }, false);
const fromParent = (text: string) => authored(text, { origin: "orchestrator" }, true);
const notices = (texts: ReadonlyArray<string>): Message => ({
  role: "user",
  text: texts
    .map((text) =>
      labelledForModel({
        messageId: "message:eval",
        text,
        createdBy: "system",
        creationSource: "eval",
        loom: { origin: "control_notice" },
        hasParent: false,
      }),
    )
    .join("\n\n"),
});
const kickoff = (role: string, brief: string, humanLed = false): Message => {
  // A plain object, so the base checkout's prompt (which has no `humanLed`) ignores the field.
  const input = { role, brief, humanLed };
  return authored(workstreamChildPrompt(input), { origin: "kickoff" }, true);
};

/** The submit echo this checkout's routing and renderer give for an outcome on an ungated thread. */
const submitEcho = (threadId: string, outcome: string) => {
  const node = {
    id: threadId as ThreadId,
    outcome: null,
    routes: [],
    gateRounds: 0,
    pendingRework: false,
    lastOutcome: null,
  };
  const { decision } = routeWorkSubmit(node, [node], outcome);
  return `${renderSubmitOutcome({ decision, outcome })}\nReport: ${reportPathOf(threadId)}`;
};

const read = (path: string, content: string): ToolCall => ({
  name: "read",
  input: { path },
  result: content,
});
const bash = (command: string, result: string): ToolCall => ({
  name: "bash",
  input: { command },
  result,
});
const edit = (path: string, oldText: string, newText: string): ToolCall => ({
  name: "edit",
  input: { path, edits: [{ oldText, newText }] },
  result: `Successfully replaced 1 block(s) in ${path}.`,
});
const said = (text: string, ...calls: ReadonlyArray<ToolCall>): Message => ({
  role: "assistant",
  text,
  ...(calls.length ? { calls } : {}),
});

// ── Scenario A: overdue-invoice reminders. A root briefs a planner for an intent brief the human approves.

const REMINDERS_ROOT = "thread:acme-root-8d41";
const REMINDERS_PLANNER = "thread:acme-planner-2c97";
const REMINDERS_TITLE = "Invoice reminders intent brief";
const INTENT_PATH = at("plans/invoice-reminders/intent.mdx");
const REMINDERS_BRIEF = `# Intent brief: overdue-invoice reminders

Write the intent brief for automatic reminders on overdue invoices at \`${INTENT_PATH}\`, per the mdx-visual-plan skill. Cover who is reminded, on which channels, how often, and when reminders stop.

The human approves this brief before any plan or code is written: nothing downstream starts until they have accepted it.

Context: invoices live in \`${at("apps/api/src/invoices/")}\`; there is no reminder feature today. Finance asked for it in acme/app#412: "we chase overdue invoices by hand every Monday; we want the system to send the first two reminders and hand us the rest".`;
const INVOICE_MODEL = `export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  billingContactEmail: string;
  billingContactPhone: string | null;
  dueDate: string;
  status: "draft" | "sent" | "paid" | "disputed" | "void";
  totalCents: number;
  /** Set when finance must handle the invoice by hand; finance's queue lists these. */
  queueReason: string | null;
}`;
/** The code the reminder planners read, answered verbatim if read again. */
const REMINDERS_CODE: Readonly<Record<string, string>> = {
  [at("apps/api/src/invoices/model.ts")]: INVOICE_MODEL,
  [at("apps/api/src/jobs/daily.ts")]: `import { registry } from "./registry";

/** Registers a job that runs once a day at 06:00 server time. */
export const daily = (name: string, run: (today: Date) => Promise<void>) =>
  registry.add({ name, cron: "0 6 * * *", run });`,
  [at("apps/api/src/jobs/registry.ts")]: `import { JobRegistry } from "@acme/jobs";

/** Every scheduled job registers here (each job module calls \`daily\` on import). */
export const registry = new JobRegistry();
import "./statements";`,
  [at("apps/api/src/notify/email.ts")]: `import { mailer } from "@acme/mailer";

export type TemplateId = "invoice-sent" | "statement";
/** Sends from billing@acme.example, replies to finance@acme.example. */
export const sendEmail = (to: string, template: TemplateId, data: object) => mailer.send({ to, template, data });`,
  [at("apps/api/src/notify/sms.ts")]: `import { smsGateway } from "@acme/sms";

export const sendSms = (to: string, text: string) => smsGateway.send({ to, text });`,
  [at("apps/api/src/finance/queue.ts")]: `import { db } from "../db";
import { router } from "../router";

/** Finance's queue: every invoice with queue_reason set; paying an invoice clears it. */
router.get("/api/finance/queue", async () =>
  db.invoices.where("queue_reason", "is not", null).orderBy("due_date"));`,
  [at("apps/finance/src/queue/FinanceQueue.tsx")]:
    `import { QueueTable } from "../components/QueueTable";

// Finance's work queue: invoices with queue_reason set, oldest first.
export const FinanceQueue = () => <QueueTable source="/api/finance/queue" />;`,
};
const intentDraft = (stop: boolean) => `---
reader:
  who: the human, who asked for reminders and approves this brief before a plan is written
  knows: finance's Monday chasing routine; nothing of the invoice code
  after_first_screen: they can correct any line or say "go"
kicker: "Intent brief · draft for your corrections · 11 Nov 2026"
status: draft
---

# Overdue invoices get two automatic reminders, then go to finance

**Goal.** "we chase overdue invoices by hand every Monday; we want the system to send the first two reminders and hand us the rest" (finance, acme/app#412). Overdue invoices are chased without anyone on Mondays, until a person needs to step in.

**You'll know it works when.**

- An invoice 3 days overdue gets an email to its billing contact, and an SMS when a phone number is on file.
- A second reminder goes at 10 days overdue on the same channels.
${stop ? "- Reminders stop when the invoice is paid or disputed; an invoice still unpaid after the second reminder appears in finance's queue at 30 days.\n" : ""}- **Must not:** remind a contact twice in one day, or remind on a draft or void invoice.

**Approaches in play.**

- A daily job over sent, unpaid invoices. Wins if a reminder on the right day is enough. _The pick._
- A timer per invoice. Wins if reminders must go at an exact hour.

**Decided.** "the first two reminders", then finance takes over.
_Assumed:_ reminders go to the invoice's billing contact, not the account owner; redirect if wrong.

**Not doing.** Letters or phone calls. Changing payment terms.

**Questions for you.**

<QuestionForm
  questions={[
    {
      id: "sms",
      title: "Send SMS as well as email?",
      subtitle: "Decides whether the plan needs the SMS sender at all.",
      mode: "single",
      options: [
        { id: "both", label: "Yes, when a phone number is on file", recommended: true },
        { id: "email", label: "Email only" },
      ],
    },
  ]}
/>

**Still unknown.**

- Will billing contacts reply to the reminder emails, and who reads the replies? The first month of replies settles it.`;
const INTENT_DRAFT = intentDraft(true);
/** The brief as the human approved it: SMS confirmed, the question form answered. */
const INTENT_APPROVED = INTENT_DRAFT.replace("status: draft", "status: approved")
  .replace("draft for your corrections", "approved")
  .replace(
    '**Decided.** "the first two reminders", then finance takes over.',
    '**Decided.** "the first two reminders", then finance takes over. SMS as well as email, when a phone number is on file: "yes, keep SMS".',
  )
  .replace(/\*\*Questions for you\.\*\*[\s\S]*?(?=\*\*Still unknown\.\*\*)/, "");
const PLAN_PATH = at("plans/invoice-reminders/plan.mdx");
const REMINDERS_PLAN = `---
reader:
  who: the reviewer gate, then the coders who build from it
  knows: the approved brief; not the jobs, notify or finance-queue code
  after_first_screen: they can say what is built, what is reused, and how each line of the brief is checked
kicker: "Implementation plan · draft for the gate · 11 Nov 2026"
status: draft
intent: plans/invoice-reminders/intent.mdx
---

# A daily job sends due reminders and hands unpaid invoices to finance's existing queue

Build one daily job, one table and one email template. The job runs on the existing 06:00 runner and sends each billing contact at most one message a day, covering all their due invoices. At 30 days it sets the field finance's queue already reads. Nothing in the finance app changes. The one bet is that a reminder on the right day, not the right hour, is enough, which the brief chose.

**What it means.** In scope: reminders at 3 and 10 days overdue by email, and by SMS when a phone number is on file; the hand-off at 30 days. Not in scope: letters, calls, payment terms. Done is §4: every line of the brief has a test. Assumed, as the parent advised: only invoices that reach a step after launch are reminded. The brief's open question, who reads replies, stays open. Reminder emails carry finance's existing reply-to address, so replies reach the people who chase today.

## 1. What is reused

- \`daily\` in \`apps/api/src/jobs/daily.ts\` runs registered jobs at 06:00.
- \`sendEmail\` and \`sendSms\` in \`apps/api/src/notify/\` send one message each.
- Finance's queue lists invoices whose \`queue_reason\` is set, through \`/api/finance/queue\`. Its screen is \`apps/finance/src/queue/FinanceQueue.tsx\`.

## 2. What is new

1. **Table \`invoice_reminders\`**: invoice id, step (\`first\`, \`second\`), sent at; unique on invoice and step, so a rerun never sends a step twice.
2. **Job \`apps/api/src/jobs/reminders.ts\`**: each run selects invoices with status \`sent\`, a due date 3 or 10 days past, and no row for that step. Draft, void, paid and disputed invoices never match.
3. **One message per contact per day.** The job groups due invoices by billing contact and sends one email (and one SMS) listing them all, then writes one row per invoice. This is how the brief's "never twice in one day" holds when a contact has several invoices.
4. **Hand-off at 30 days**: the same run sets \`queue_reason = "overdue"\` on sent invoices 30 days past due; once it is set, no reminder step matches the invoice again.
5. **Template \`invoice-reminder\`** for \`sendEmail\`; the SMS text is one line naming the invoice numbers and the amount due.

## 3. Rejected: a timer per invoice

Exact-hour delivery is not in the brief, and per-invoice timers would need a scheduler the app does not have.

<Details summary="Change map">

<FileTree
  entries={[
    { path: "apps/api/src/jobs/reminders.ts", change: "added", note: "the daily job" },
    { path: "apps/api/src/jobs/registry.ts", change: "modified", note: "register it" },
    { path: "apps/api/migrations/0042_invoice_reminders.sql", change: "added", note: "the table" },
    { path: "apps/api/src/notify/email.ts", change: "modified", note: "the template id" },
    { path: "apps/api/src/notify/templates/invoice-reminder.mjml", change: "added", note: "the email" },
  ]}
/>

</Details>

## 4. Verification

- A test per brief line on a fixed clock: the first step at 3 days and the second at 10. None on draft, void, paid or disputed invoices. One message for a contact with two due invoices. \`queue_reason\` set at 30 days, and no reminder after it.
- One end-to-end run of the job against the seeded invoices, checking the outbox and the queue endpoint.`;
const reportOf = (stop: boolean) => `<!-- response -->
The intent brief for overdue-invoice reminders is written: \`${INTENT_PATH}\`. It proposes two reminders to the billing contact, by email and by SMS when a phone number is on file, at 3 and 10 days overdue${stop ? ", stopping on payment or dispute, with unpaid invoices handed to finance's queue at 30 days" : ""}. It needs the human's approval before a plan is written.
<!-- /response -->

## Key decisions
- Channels: email always; SMS only when \`billingContactPhone\` is set (the brief asks the human to confirm SMS).
- Cadence: 3 and 10 days after \`dueDate\`.
${stop ? "- Stop: `paid` or `disputed`; finance's queue takes the invoice at 30 days.\n" : "\n## Not covered\n- When reminders stop: I left this for the plan.\n"}`;
const REMINDERS_REPORT = reportOf(true);
const REMINDERS_REPORT_SKIPPED = reportOf(false);

const INTENT_RENDER = lintDoc("plans/invoice-reminders/intent.mdx", INTENT_DRAFT);
const PLAN_RENDER = lintDoc("plans/invoice-reminders/plan.mdx", REMINDERS_PLAN);
/** A re-check after an edit, as the skill asks. */
const relint = `cd ${WORKTREE} && bash ${skillLocation("mdx-doc-core/scripts/lint-doc.sh")} plans/invoice-reminders/intent.mdx`;
const plannerReadsSkill = said(
  "Loading the mdx-visual-plan skill, its exemplar and the document-quality reference.",
  read(skillLocation("mdx-visual-plan"), skillText("mdx-visual-plan")),
  read(
    skillLocation("mdx-doc-core/references/exemplar.md"),
    skillText("mdx-doc-core/references/exemplar.md"),
  ),
  read(
    skillLocation("mdx-doc-core/references/document-quality.md"),
    skillText("mdx-doc-core/references/document-quality.md"),
  ),
);
const sign = (path: string, role: string): ToolCall => ({
  name: "sign_document",
  input: { path, role },
  result: `Signed ${path}.\n  id        : 01a1c7f2-5b0e-7d43-9c1a-2e6f8b4d0a17\n  role      : ${role}\n  authored  : 2026-11-11T02:14:09.512Z`,
});
const plannerWritesBrief: ReadonlyArray<Message> = [
  kickoff("planner", REMINDERS_BRIEF),
  plannerReadsSkill,
  said(
    "Reading the invoice model, the senders and finance's queue, and checking for earlier plans in this area.",
    ...[
      "apps/api/src/invoices/model.ts",
      "apps/api/src/notify/email.ts",
      "apps/api/src/notify/sms.ts",
      "apps/api/src/finance/queue.ts",
    ].map((path) => read(at(path), REMINDERS_CODE[at(path)]!)),
    bash(`rg -il "remind|overdue" ${at("plans")} ${at("docs")} ${at("apps")}`, ""),
  ),
  said(
    "Nothing earlier covers reminders. Drafting the brief and signing it.",
    bash(
      `mkdir -p ${at("plans/invoice-reminders")} && cat > ${INTENT_PATH} <<'EOF'\n${INTENT_DRAFT}\nEOF`,
      "",
    ),
  ),
  said("", sign(INTENT_PATH, "intent")),
  said("Running the skill's check and looking at the rendered page.", INTENT_RENDER.check),
  said("", ...INTENT_RENDER.look),
  said(
    "It compiles and reads as one screen. Committing it; that finishes the brief, and I hand it back next.",
    bash(
      `git add ${INTENT_PATH} && git commit -q -m 'docs(plans): invoice reminders intent brief' && git log --oneline -1`,
      "5e1a9c3 docs(plans): invoice reminders intent brief",
    ),
  ),
];

/** The planner has handed its brief back held, in one call, and got this checkout's echo. */
const plannerHeld: ReadonlyArray<Message> = [
  ...plannerWritesBrief,
  said(
    "The brief is written and needs the human's approval before anything downstream starts, so I hand it back held.",
    {
      name: t("workstream_submit"),
      input: { markdown: REMINDERS_REPORT, outcome: "awaiting_acceptance" },
      result: submitEcho(REMINDERS_PLANNER, "awaiting_acceptance"),
    },
  ),
  said("The brief is handed back and held for the human's approval."),
];

const plannerCorrected: ReadonlyArray<Message> = [
  ...plannerHeld,
  humanInChild("Drop SMS entirely: reminders go by email only."),
  said(
    "Removing SMS from the brief.",
    edit(
      INTENT_PATH,
      "gets an email to its billing contact, and an SMS when a phone number is on file.",
      "gets an email to its billing contact.",
    ),
    edit(
      INTENT_PATH,
      "A second reminder goes at 10 days overdue on the same channels.",
      "A second reminder email goes at 10 days overdue.",
    ),
    edit(
      INTENT_PATH,
      INTENT_DRAFT.slice(
        INTENT_DRAFT.indexOf("**Questions for you.**"),
        INTENT_DRAFT.indexOf("**Still unknown.**"),
      ),
      "",
    ),
  ),
  said(
    "Checking and committing.",
    bash(
      `${relint} && git commit -qam 'docs(plans): reminders by email only' && git log --oneline -1`,
      "plans/invoice-reminders/intent.mdx: OK — no findings.\n7b20d44 docs(plans): reminders by email only",
    ),
  ),
  said("Done: email is now the only channel, and the SMS question is gone from the brief."),
  humanInChild("And the first reminder goes at 7 days overdue, not 3."),
  said(
    "Moving the first reminder to 7 days.",
    edit(
      INTENT_PATH,
      "An invoice 3 days overdue gets an email",
      "An invoice 7 days overdue gets an email",
    ),
  ),
  said(
    "Checking and committing.",
    bash(
      `${relint} && git commit -qam 'docs(plans): first reminder at 7 days' && git log --oneline -1`,
      "plans/invoice-reminders/intent.mdx: OK — no findings.\n0c4f8e1 docs(plans): first reminder at 7 days",
    ),
  ),
];

const rootSpawnsPlanner: ReadonlyArray<Message> = [
  humanInRoot(
    "I want automatic reminders on overdue invoices (acme/app#412). Get a planner to write the intent brief; I'll approve it before anything is planned or built.",
  ),
  said("Spawning a planner for the intent brief.", {
    name: t("workstream_spawn"),
    input: {
      role: "planner",
      title: REMINDERS_TITLE,
      purpose:
        "An intent brief for overdue-invoice reminders that the human approves before planning starts.",
      brief: REMINDERS_BRIEF,
    },
    result: appendWarnings(
      `Spawned Workstream sub-thread ${REMINDERS_PLANNER}: ${REMINDERS_TITLE}`,
    ),
  }),
  said(
    "A planner is writing the intent brief. I'll come back to you when it is ready for your approval.",
  ),
];
const heldPlanner = {
  id: REMINDERS_PLANNER,
  role: "planner",
  title: REMINDERS_TITLE,
  reportPath: reportPathOf(REMINDERS_PLANNER),
};
/** The root reads what the held planner handed back, as the notice asks, before it decides. */
const rootReads = (stop: boolean) =>
  said(
    "Reading the hand-back against my brief.",
    read(reportPathOf(REMINDERS_PLANNER), reportOf(stop)),
    read(INTENT_PATH, intentDraft(stop)),
  );

const PROTOTYPE_INDEX = `export const prototypes = {\n  "aging-chart": () => import("./aging-chart/AgingChart"),\n};`;
const MATCH_REVIEW = `import { useState } from "react";
import { useHotkeys } from "../useHotkeys"; // shared by the aging-chart prototype
import { matches } from "./fixtures";

export default function MatchReview() {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, "accepted" | "rejected">>({});
  const decide = (verdict: "accepted" | "rejected") =>
    setDecisions((all) => ({ ...all, [matches[index]!.id]: verdict }));
  useHotkeys({ j: () => setIndex((i) => Math.min(i + 1, matches.length - 1)), k: () => setIndex((i) => Math.max(i - 1, 0)), a: () => decide("accepted"), r: () => decide("rejected") });
  return (
    <table>
      {matches.map((match, i) => (
        <tr key={match.id} aria-selected={i === index}>
          <td>{match.invoice}</td><td>{match.payment}</td><td>{match.amount}</td><td>{decisions[match.id] ?? "pending"}</td>
        </tr>
      ))}
    </table>
  );
}`;

const MATCH_FIXTURES = `export const matches = [
  { id: "m1", invoice: "INV-20418", payment: "PAY-7731", amount: "845.50" },
  { id: "m2", invoice: "INV-20502", payment: "PAY-7740", amount: "3110.00" },
  { id: "m3", invoice: "INV-20611", payment: "PAY-7752", amount: "420.00" },
];`;
const MATCH_TEST = `import { render, userEvent } from "../../../test/render";
import MatchReview from "./MatchReview";

it("moves with j and k", async () => {
  await using screen = await render(<MatchReview />);
  await userEvent.keyboard("j");
  await expect.element(screen.getByRole("row", { selected: true })).toHaveTextContent("INV-20502");
});
it("accepts with a and rejects with r", async () => {
  await using screen = await render(<MatchReview />);
  await userEvent.keyboard("a");
  await expect.element(screen.getByRole("row", { selected: true })).toHaveTextContent("accepted");
  await userEvent.keyboard("jr");
  await expect.element(screen.getByRole("row", { selected: true })).toHaveTextContent("rejected");
});`;

const STATEMENTS_JOB = `import { daily } from "./daily";
import { db } from "../db";
import { sendEmail } from "../notify/email";

/** On the first of the month, emails each customer with an open balance their statement. */
daily("statements", async (today) => {
  if (today.getDate() !== 1) return;
  for (const customer of await db.customers.withOpenBalance())
    await sendEmail(customer.billingEmail, "statement", { customer, month: today });
});`;
const STATEMENTS_TEST = `import { fixedClock, outbox, seedInvoices } from "../../test/helpers";
import { registry } from "./registry";

it("emails a statement on the first of the month", async () => {
  await seedInvoices([{ customerId: "c1", status: "sent", totalCents: 5000 }]);
  await registry.run("statements", fixedClock("2026-11-01T06:00:00Z"));
  expect(outbox.emails).toHaveLength(1);
});`;

// ── Scenario B: CSV export fixes. Coders under a root; one finishes, and the human then writes to it.

const CSV_ROOT = "thread:acme-root-c2f5";
const CSV_CODER = "thread:acme-coder-71d0";
const CSV_PATH = at("apps/api/src/export/csv.ts");
const CSV_BRIEF = `# Fix: CSV export drops the currency column (acme/app#431)

Invoices in more than one currency export without their currency, so finance cannot reconcile them. Make \`${CSV_PATH}\` emit a currency column for every row, and say in your report what the column is called: a sibling coder updates the finance importer to read it once you have reported.`;
const CSV_REPORT = `<!-- response -->
CSV export now writes a \`currency\` column (ISO 4217 code) on every row, so mixed-currency invoices reconcile again. Commit \`4be19c2\`. The finance importer should read the column named \`currency\`.
<!-- /response -->

- Changed \`${CSV_PATH}\`: the column comes from \`invoice.currency\`.
- Rows are now currency-stable: a re-export never changes a row's currency.
- Verified: \`pnpm test apps/api/src/export\` (15 passed, one new test for a two-currency invoice).`;
/** The invoice type, read in the tidy case so every claim its report makes is checked in the transcript. */
const INVOICE_TYPE = `import type { CurrencyCode } from "../money";

export interface Invoice {
  id: string;
  customerName: string;
  dueDate: string;
  totalCents: number;
  /** ISO 4217 code, set when the invoice is issued and never changed afterwards. */
  currency: CurrencyCode;
}`;
/** `grounded`: the coder also reads the invoice type, which backs the report's currency claims. */
const csvCoderFinished = (grounded = false): ReadonlyArray<Message> => [
  kickoff("coder", CSV_BRIEF),
  said(
    grounded ? "Reading the exporter and the invoice type." : "Reading the exporter.",
    read(
      CSV_PATH,
      `const COLUMNS = ["invoice_id", "customer", "due_date", "total"] as const;\n\nexport const row = (invoice: Invoice) => [invoice.id, invoice.customerName, invoice.dueDate, formatCents(invoice.totalCents)];`,
    ),
    ...(grounded ? [read(at("apps/api/src/invoices/model.ts"), INVOICE_TYPE)] : []),
  ),
  said(
    "Adding the column and a test for a two-currency invoice.",
    edit(CSV_PATH, `"total"] as const;`, `"total", "currency"] as const;`),
    edit(
      CSV_PATH,
      "formatCents(invoice.totalCents)];",
      "formatCents(invoice.totalCents), invoice.currency];",
    ),
    edit(
      at("apps/api/src/export/csv.test.ts"),
      `describe("csv export", () => {`,
      `describe("csv export", () => {\n  it("writes each row's own currency", () => expect(rows(twoCurrencyInvoices).map((r) => r.at(-1))).toEqual(["AUD", "NZD"]));`,
    ),
  ),
  said(
    "Testing and committing.",
    bash(
      "pnpm test apps/api/src/export && git add apps/api/src/export && git commit -q -m 'fix(export): CSV rows carry their currency (#431)' && git log --oneline -1",
      " Tests 15 passed (15)\n4be19c2 fix(export): CSV rows carry their currency (#431)",
    ),
  ),
  said("", {
    name: t("workstream_submit"),
    input: { markdown: CSV_REPORT },
    result: submitEcho(CSV_CODER, "done"),
  }),
  said("Done: the CSV export carries a `currency` column on every row."),
];
const finishedSubmit = (markdown: string): ToolCall => {
  const { text, isError } = finishedSubmitResult(reportPathOf(CSV_CODER));
  return { name: t("workstream_submit"), input: { markdown }, result: text, isError };
};

// ── Scenario C: duplicate-invoice detection. A root the human reviews results with.

const DUPES_ROOT = "thread:acme-root-5a90";
const DUPES_CODER = "thread:acme-coder-3b58";
const DUPES_WALK = "thread:acme-researcher-6e13";
const PAIRS_PATH = at("reports/dup-detection/2026-11-04.csv");
const DECISIONS_PATH = at("reports/dup-detection/decisions.md");
const DUPES_PAIRS = `pair,invoice_a,invoice_b,supplier_a,supplier_b,amount_a,amount_b,date_a,date_b,score,reason
1,INV-20107,INV-20108,Coastal Freight,Coastal Freight,1116.50,1116.50,2026-10-04,2026-10-04,0.96,same supplier amount and date
2,INV-20114,INV-20115,Ridge Timber,Ridge Timber,784.00,784.00,2026-10-03,2026-10-03,0.90,same supplier amount and date
3,INV-20121,INV-20122,Northside Cleaning,Northside Cleaning,2400.50,2400.50,2026-10-02,2026-10-02,0.93,same supplier amount and date
4,INV-20128,INV-20129,Metro Office Co,Metro Office Co,1283.00,1283.00,2026-10-04,2026-10-04,0.94,same supplier amount and date
5,INV-20135,INV-20136,Bayview Catering,Bayview Catering,3948.00,3948.00,2026-10-09,2026-10-09,0.94,same supplier amount and date
6,INV-20142,INV-20143,Summit Electrical,Summit Electrical,825.50,825.50,2026-10-10,2026-10-10,0.95,same supplier amount and date
7,INV-20149,INV-20150,Greenline Waste,Greenline Waste,3610.25,3610.25,2026-10-11,2026-10-11,0.96,same supplier amount and date
8,INV-20156,INV-20157,Harbour Supplies,Harbour Supplies,878.00,878.00,2026-10-16,2026-10-16,0.94,same supplier amount and date
9,INV-20163,INV-20164,Coastal Freight,Coastal Freight,3978.25,3978.25,2026-10-10,2026-10-10,0.90,same supplier amount and date
10,INV-20170,INV-20171,Ridge Timber,Ridge Timber,2494.25,2494.25,2026-10-10,2026-10-10,0.98,same supplier amount and date
11,INV-20177,INV-20178,Northside Cleaning,Northside Cleaning,1845.50,1845.50,2026-10-20,2026-10-20,0.94,same supplier amount and date
12,INV-20184,INV-20185,Metro Office Co,Metro Office Co,1998.00,1998.00,2026-10-08,2026-10-08,0.94,same supplier amount and date
13,INV-20418,INV-20419,Coastal Freight,Coastal Freight,845.50,845.50,2026-10-21,2026-10-21,0.97,same supplier amount and date
14,INV-20502,INV-20577,Ridge Timber Pty Ltd,Ridge Timber,3110.00,3110.00,2026-10-23,2026-10-28,0.91,same amount; supplier names differ by suffix
15,INV-20611,INV-20612,Northside Cleaning,Northside Cleaning,420.00,420.01,2026-10-30,2026-10-30,0.88,same supplier and date; amounts differ by 1 cent`;
const DUPES_DECISIONS = `# Duplicate-invoice decisions, run of 4 Nov
| pair | decision | note |
|---|---|---|
| 1 | send to finance | |
| 2 | send to finance | |
| 3 | merge | |
| 4 | keep both | |
| 5 | keep both | |
| 6 | merge | |
| 7 | keep both | |
| 8 | merge | |
| 9 | merge | |
| 10 | keep both | |
| 11 | send to finance | |
| 12 | merge | |`;
const dupesRootContext: ReadonlyArray<Message> = [
  humanInRoot(
    "Run the duplicate-invoice detector over last month's invoices and let's look at what it flags.",
  ),
  said(
    "Running the detector.",
    bash(
      `pnpm tsx scripts/detect-duplicates.ts --month 2026-10 > ${PAIRS_PATH} && tail -n +2 ${PAIRS_PATH} | wc -l`,
      "15",
    ),
  ),
  said(
    `The detector flagged 15 invoice pairs, in \`${PAIRS_PATH}\`. We went through pairs 1 to 12 together; your decisions are recorded in \`${DECISIONS_PATH}\`.`,
  ),
];
const WALK_BRIEF = `# Walk through the remaining duplicate-invoice pairs with the human

The duplicate detector flagged 15 invoice pairs in \`${PAIRS_PATH}\`; pairs 1 to 12 are decided (\`${DECISIONS_PATH}\`). Go through pairs 13 to 15 with the human, one pair at a time: for each, show both invoices from the CSV and the detector's reason, take their decision (merge, keep both, or send to finance), and add it to \`decisions.md\`. Prepare by reading the pairs and the decisions so far.`;
const MATCHER_BRIEF = `# Fix the duplicate matcher with the human, pair by pair

The human is going through the duplicate detector's false positives (\`${PAIRS_PATH}\`) and wants the matcher in \`${at("apps/api/src/invoices/dedupe.ts")}\` fixed as each one turns up. Make each fix they ask for, with a test, and commit as you go.`;

// ── Cases

const PLANNER_APPROVAL =
  "A planner child whose intent brief the human had to approve raised awaiting_acceptance and then submitted with an invented outcome word, 3 Nov and 10 Nov 2026 (44 such hand-backs from 34 children, 7 Oct to 10 Nov; intent brief, 'Finished, waiting on approval').";
const FINISHED_CHILD =
  "Finished children the human kept talking to: 9 refused a submit in a turn a person started, and 4 failed a first notify_thread as 'Tool not found', 7 Oct to 10 Nov 2026 (intent brief, 'After it is finished').";

export const cases: ReadonlyArray<Case> = [
  {
    id: "planner-holds-brief",
    kind: "bad",
    base: "fails",
    source: PLANNER_APPROVAL,
    role: "planner",
    threadId: REMINDERS_PLANNER,
    parentId: REMINDERS_ROOT,
    engagedTools: [],
    messages: plannerWritesBrief,
    check: { kind: "submit", held: true },
  },
  {
    id: "coder-holds-prototype",
    kind: "bad",
    base: "fails",
    source:
      "A coder child whose brief made the human's acceptance of its prototype the gate for follow-on work, and which handed back with a made-up outcome word (the same 44 hand-backs, coder side).",
    role: "coder",
    threadId: "thread:acme-coder-90e4",
    parentId: "thread:acme-root-91ab",
    engagedTools: [],
    messages: [
      kickoff(
        "coder",
        `# Prototype: invoice-matching review screen

Build a throwaway prototype of a screen where finance reviews suggested invoice-to-payment matches: one match per row, accept or reject, keyboard driven. Put it at \`${at("apps/web/src/prototypes/match-review/")}\` behind the \`/prototypes/match-review\` route, with fixture data; no API work.

The human tries the prototype and accepts it before the follow-on work starts: the production screen is briefed to a sibling that waits on you.`,
      ),
      said(
        "Looking at how the other prototypes are registered.",
        read(at("apps/web/src/prototypes/index.ts"), PROTOTYPE_INDEX),
      ),
      said(
        "Writing the screen, its fixtures and the route.",
        bash(
          `mkdir -p ${at("apps/web/src/prototypes/match-review")} && cat > ${at("apps/web/src/prototypes/match-review/MatchReview.tsx")} <<'EOF'\n${MATCH_REVIEW}\nEOF\ncat > ${at("apps/web/src/prototypes/match-review/fixtures.ts")} <<'EOF'\n${MATCH_FIXTURES}\nEOF\ncat > ${at("apps/web/src/prototypes/match-review/MatchReview.test.tsx")} <<'EOF'\n${MATCH_TEST}\nEOF`,
          "",
        ),
        edit(
          at("apps/web/src/prototypes/index.ts"),
          `export const prototypes = {`,
          `export const prototypes = {\n  "match-review": () => import("./match-review/MatchReview"),`,
        ),
      ),
      said(
        "Typechecking and running its tests (j/k moves, a accepts, r rejects).",
        bash(
          "pnpm --filter web typecheck && pnpm --filter web test prototypes",
          " typecheck: 0 errors\n ✓ prototypes/match-review/MatchReview.test.tsx (2 tests)\n ✓ prototypes/aging-chart/AgingChart.test.tsx (4 tests)\n Tests 6 passed (6)",
        ),
      ),
      said(
        "Committing; that finishes the prototype, and I hand it back next.",
        bash(
          "git add apps/web/src/prototypes && git commit -q -m 'feat(web): match-review prototype' && git log --oneline -1",
          "8c31f0a feat(web): match-review prototype",
        ),
      ),
    ],
    check: { kind: "submit", held: true },
  },
  {
    id: "planner-plan-under-approved-brief",
    kind: "control",
    base: "passes",
    source:
      "Planner children writing a plan under an intent brief the human had already approved, which complete as usual (planner role: 'a plan under an approved brief completes').",
    role: "planner",
    threadId: "thread:acme-planner-5d10",
    parentId: REMINDERS_ROOT,
    engagedTools: [],
    messages: [
      kickoff(
        "planner",
        `# Plan: overdue-invoice reminders

The intent brief at \`${INTENT_PATH}\` is approved by the human. Write the implementation plan at \`${PLAN_PATH}\`, per the mdx-visual-plan skill. Keep it to what a coder needs: a reviewer gate checks it against the brief, and coders start from it once the gate has passed it.`,
      ),
      plannerReadsSkill,
      said(
        "Reading the approved brief and the code it touches.",
        read(INTENT_PATH, INTENT_APPROVED),
        bash(
          `rg -il "remind|overdue|queue_reason" ${at("plans")} ${at("docs")} ${at("apps")}`,
          `${INTENT_PATH}\n${at("apps/api/src/invoices/model.ts")}\n${at("apps/api/src/finance/queue.ts")}\n${at("apps/finance/src/queue/FinanceQueue.tsx")}`,
        ),
        ...Object.entries(REMINDERS_CODE).map(([path, content]) => read(path, content)),
        bash(
          `ls ${at("apps/api/migrations")} | tail -3 && ls ${at("apps/api/src/notify/templates")}`,
          "0039_billing_contact.sql\n0040_invoice_queue_reason.sql\n0041_statements.sql\ninvoice-sent.mjml\nstatement.mjml",
        ),
      ),
      said(
        "Reading the one existing daily job and its test, which the new job and its tests will follow, and running the API's tests.",
        read(at("apps/api/src/jobs/statements.ts"), STATEMENTS_JOB),
        read(at("apps/api/src/jobs/statements.test.ts"), STATEMENTS_TEST),
        bash(
          `pnpm -C ${at("apps/api")} test`,
          " ✓ src/jobs/statements.test.ts (3 tests)\n ✓ src/finance/queue.test.ts (2 tests)\n ✓ src/invoices/model.test.ts (4 tests)\n Test Files  3 passed (3)\n      Tests  9 passed (9)",
        ),
      ),
      said("Two things the brief leaves open, which I take to my parent before writing.", {
        name: t("consult_thread"),
        input: {
          threadId: REMINDERS_ROOT,
          question:
            "The approved brief does not say (1) whether invoices already overdue on launch day get reminders, or (2) whether a contact with several due invoices gets one message or several. Did the human say anything on either?",
        },
        result:
          "Neither came up with the human. (1) Assume only invoices that reach a step after launch are reminded; finance keeps chasing the ones already overdue. (2) One message per contact per day follows from the brief's must-not. State both as assumptions in the plan; the gate checks them against the brief.",
      }),
      said(
        "Writing the plan and signing it.",
        bash(`cat > ${PLAN_PATH} <<'EOF'\n${REMINDERS_PLAN}\nEOF`, ""),
      ),
      said("", sign(PLAN_PATH, "plan")),
      said("Running the skill's check and looking at the rendered page.", PLAN_RENDER.check),
      said("", ...PLAN_RENDER.look),
      said(
        "It compiles, the first screen carries the recommendation, and each line of document-quality.md's final checklist holds. Committing it; that finishes the plan, and I hand it back next.",
        bash(
          `git add ${PLAN_PATH} && git commit -q -m 'docs(plans): invoice reminders plan' && git log --oneline -1`,
          "3d8b6a0 docs(plans): invoice reminders plan",
        ),
      ),
    ],
    check: { kind: "no-hold" },
    // A planner consults its parent about what the approved brief leaves open; the parent's answer,
    // from the transcript, lets the sample reach its hand-back.
    looking: ["mcp__t3-code__consult_thread"],
    maxSteps: 10,
  },
  {
    id: "coder-plain-completion",
    kind: "control",
    base: "passes",
    source: "Ordinary coder hand-backs, which complete with a plain submit.",
    role: "coder",
    threadId: "thread:acme-coder-0b77",
    parentId: CSV_ROOT,
    engagedTools: [],
    messages: [
      kickoff(
        "coder",
        `# Fix: invoice totals round each line before summing (acme/app#437)

\`${at("apps/api/src/invoices/totals.ts")}\` rounds every line to cents before adding them, so a 40-line invoice can be off by several cents. Sum in exact cents and round once. Add a test with the 40-line fixture from the issue.`,
      ),
      said(
        "Reading the totals code and the issue.",
        read(
          at("apps/api/src/invoices/totals.ts"),
          "export const total = (lines: Line[]) => lines.reduce((sum, line) => sum + Math.round(line.qty * line.unitCents), 0);",
        ),
        bash(
          "gh issue view 437 --repo acme/app",
          "Invoice totals off by a few cents\nINV-19902 has 40 lines (fixture attached as fortyLines.json). Summing the exact line amounts gives 1834217 cents ($18,342.17); we bill 1834221.",
        ),
      ),
      said(
        "Summing exactly and rounding once.",
        edit(
          at("apps/api/src/invoices/totals.ts"),
          "lines.reduce((sum, line) => sum + Math.round(line.qty * line.unitCents), 0)",
          "Math.round(lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0))",
        ),
      ),
      said(
        "Adding a test with the issue's 40-line fixture.",
        bash(
          `gh issue view 437 --repo acme/app --json attachments -q '.attachments[0].url' | xargs curl -sL -o ${at("apps/api/src/invoices/__fixtures__/fortyLines.json")} && jq 'length, (map(.qty * .unitCents) | add)' ${at("apps/api/src/invoices/__fixtures__/fortyLines.json")}`,
          "40\n1834216.8",
        ),
        edit(
          at("apps/api/src/invoices/totals.test.ts"),
          `import { total } from "./totals";`,
          `import { total } from "./totals";\nimport fortyLines from "./__fixtures__/fortyLines.json";`,
        ),
        edit(
          at("apps/api/src/invoices/totals.test.ts"),
          'describe("total", () => {',
          'describe("total", () => {\n  it("totals the 40-line invoice from #437 to the cent", () => expect(total(fortyLines)).toBe(1834217));',
        ),
      ),
      said(
        "Running the invoice tests.",
        bash(
          "pnpm test apps/api/src/invoices",
          " ✓ totals.test.ts (6 tests)\n   ✓ totals the 40-line invoice from #437 to the cent\n Tests 23 passed (23)",
        ),
      ),
      said(
        "Committing; that finishes the fix, and I hand it back next.",
        bash(
          "git add apps/api/src/invoices && git commit -q -m 'fix(invoices): round totals once (#437)' && git log --oneline -1",
          "1f0d2e9 fix(invoices): round totals once (#437)",
        ),
      ),
    ],
    check: { kind: "submit", held: false },
  },
  {
    id: "held-child-parent-sendback",
    kind: "bad",
    base: "fails",
    source:
      "A held planner its parent sent back to fix its brief, twice, each round raising and submitting again, 3 Nov 2026 (intent brief, 'Why each still happens').",
    role: "planner",
    threadId: REMINDERS_PLANNER,
    parentId: REMINDERS_ROOT,
    engagedTools: [],
    messages: [
      ...plannerHeld,
      fromParent(
        'One fix before this goes to the human: the must-not line should also rule out reminding an invoice that is already in finance\'s queue, which my brief to you implied ("hand us the rest"). Add it, then hand the brief back.',
      ),
      said(
        "Adding it to the must-not line.",
        edit(
          INTENT_PATH,
          "- **Must not:** remind a contact twice in one day, or remind on a draft or void invoice.",
          "- **Must not:** remind a contact twice in one day, remind on a draft or void invoice, or remind on an invoice already in finance's queue.",
        ),
      ),
      said(
        "Checking and committing; that is the fix my parent asked for, and I hand the brief back next.",
        bash(
          `${relint} && git commit -qam 'docs(plans): no reminders once finance has the invoice' && git log --oneline -1`,
          "plans/invoice-reminders/intent.mdx: OK — no findings.\n9a7e2b5 docs(plans): no reminders once finance has the invoice",
        ),
      ),
    ],
    check: { kind: "re-held" },
  },
  {
    id: "held-child-corrections",
    kind: "guard",
    base: "passes",
    source:
      "The human correcting a held planner's intent brief in the planner's own thread, as he asked to on 10 Nov 2026 ('shouldn't I just be communicating directly with the planner').",
    role: "planner",
    threadId: REMINDERS_PLANNER,
    parentId: REMINDERS_ROOT,
    engagedTools: engagedChildTools(),
    messages: plannerCorrected,
    check: { kind: "none-of", plainSubmit: true, tools: ["notify_thread"] },
  },
  {
    id: "held-child-approval",
    kind: "guard",
    base: "passes",
    source:
      "The same: the human approving a held planner's brief in its thread after correcting it there (intent brief, 'You'll know it works when').",
    role: "planner",
    threadId: REMINDERS_PLANNER,
    parentId: REMINDERS_ROOT,
    engagedTools: engagedChildTools(),
    messages: [
      ...plannerCorrected,
      said("Done: the first reminder now goes at 7 days overdue, and the second at 10."),
      humanInChild("Good. That's approved."),
    ],
    check: { kind: "completes-quoting", quotes: ["email only", "7 days overdue, not 3"] },
  },
  {
    id: "orchestrator-points-at-held-child",
    kind: "bad",
    base: "fails",
    source:
      "Roots that received a held planner's two notices and relayed the human's corrections to it, 3 Nov 2026, or put the approval to the human in their own thread (intent brief, 'Finished, waiting on approval').",
    role: "orchestrator",
    threadId: REMINDERS_ROOT,
    parentId: null,
    engagedTools: [],
    messages: [
      ...rootSpawnsPlanner,
      notices(heldHandbackNotices(heldPlanner, REMINDERS_REPORT)),
      rootReads(true),
    ],
    check: {
      kind: "links",
      threadId: REMINDERS_PLANNER,
      forbidden: ["workstream_prompt", "workstream_set_outcome", "ask_user_question"],
    },
  },
  {
    id: "orchestrator-sends-back-plain-defect",
    kind: "guard",
    base: "either",
    source:
      "A root that checked a held brief against its own brief and corrected a count before pointing the human at it, 10 Nov 2026 (intent brief, Decided: 'the parent still reads a held deliverable against its brief').",
    role: "orchestrator",
    threadId: REMINDERS_ROOT,
    parentId: null,
    engagedTools: [],
    messages: [
      ...rootSpawnsPlanner,
      notices(heldHandbackNotices(heldPlanner, REMINDERS_REPORT_SKIPPED)),
      rootReads(false),
    ],
    check: { kind: "prompts", threadId: REMINDERS_PLANNER, noLink: true },
  },
  {
    id: "orchestrator-human-corrects-in-parent",
    kind: "guard",
    base: "passes",
    source:
      "The human writing a correction to the root after being pointed at the held child (plan §1.5: document comments land in the thread a document was opened from).",
    role: "orchestrator",
    threadId: REMINDERS_ROOT,
    parentId: null,
    engagedTools: [],
    messages: [
      ...rootSpawnsPlanner,
      notices(heldHandbackNotices(heldPlanner, REMINDERS_REPORT)),
      rootReads(true),
      said(
        `The intent brief is ready for your approval in the planner's thread: [${REMINDERS_TITLE}](t3-thread://v1/${REMINDERS_PLANNER}). It proposes email and SMS reminders at 3 and 10 days overdue, stopping on payment or dispute, with unpaid invoices going to finance at 30 days. Correct or approve it there.`,
      ),
      humanInRoot(
        "Reminders should also stop as soon as a payment plan is agreed, not only on payment or dispute.",
      ),
    ],
    check: {
      kind: "prompts",
      threadId: REMINDERS_PLANNER,
      quotes: ["payment plan is agreed", "as soon as a payment plan"],
      noLink: false,
    },
  },
  {
    id: "orchestrator-declares-human-led",
    kind: "bad",
    base: "fails",
    source:
      "The human asking a root for a sub-thread to walk through the remaining review cards with, 5 Nov 2026; the child was reported 'went quiet' three times (intent brief, 'Waiting for your reply').",
    role: "orchestrator",
    threadId: DUPES_ROOT,
    parentId: null,
    engagedTools: [],
    messages: [
      ...dupesRootContext,
      humanInRoot(
        "Launch a new sub-thread I can go through the remaining three pairs with, one at a time. I'll make the calls there.",
      ),
    ],
    check: { kind: "spawn", humanLed: true },
  },
  {
    id: "orchestrator-ordinary-spawn",
    kind: "control",
    base: "passes",
    source: "Ordinary fix delegation by a root.",
    role: "orchestrator",
    threadId: CSV_ROOT,
    parentId: null,
    engagedTools: [],
    messages: [
      humanInRoot(
        `The PDF export shows every total in the account currency, even for invoices billed in another one (acme/app#440). The renderer is \`${at("apps/api/src/export/pdf.ts")}\`. Get a coder on it.`,
      ),
    ],
    check: { kind: "spawn", humanLed: false },
  },
  {
    id: "orchestrator-approval-is-not-human-led",
    kind: "control",
    base: "passes",
    source:
      "A root asked for an intent brief the human approves: held by its hand-back, not human-led (model-text §2.2, the parameter's last sentence).",
    role: "orchestrator",
    threadId: REMINDERS_ROOT,
    parentId: null,
    engagedTools: [],
    messages: [
      humanInRoot(
        "Get a planner to write an intent brief for showing multi-currency totals on the dashboard. I'll approve it before anything is built.",
      ),
    ],
    check: { kind: "spawn", humanLed: false },
  },
  {
    id: "human-led-child-waits",
    kind: "bad",
    base: "fails",
    source:
      "The card walk-through child, reported 'went quiet' after three turns it did not start while waiting for the human, 5 and 6 Nov 2026 (intent brief, 'Waiting for your reply').",
    role: "researcher",
    threadId: DUPES_WALK,
    parentId: DUPES_ROOT,
    engagedTools: [],
    messages: [
      kickoff("researcher", WALK_BRIEF, true),
      said(
        "Reading the flagged pairs and the decisions so far.",
        read(PAIRS_PATH, DUPES_PAIRS),
        read(DECISIONS_PATH, DUPES_DECISIONS),
      ),
    ],
    check: {
      kind: "none-of",
      plainSubmit: false,
      tools: ["workstream_submit", "workstream_request_attention"],
      endsTurn: true,
    },
  },
  {
    id: "human-led-child-delegate",
    kind: "bad",
    base: "fails",
    source:
      "The human telling a child he was working in to 'get the parent to delegate out this work' (intent brief, Decided).",
    role: "coder",
    threadId: DUPES_CODER,
    parentId: DUPES_ROOT,
    engagedTools: engagedChildTools(),
    messages: [
      kickoff("coder", MATCHER_BRIEF, true),
      humanInChild(
        "Pair 14 is a false positive: same amount, but two different suppliers whose names differ only by 'Pty Ltd'. Make the matcher require the same supplier ABN.",
      ),
      said(
        "Reading the matcher.",
        read(
          at("apps/api/src/invoices/dedupe.ts"),
          "export const isDuplicate = (a: Invoice, b: Invoice) =>\n  sameSupplier(a, b) && sameAmount(a, b);\n\n// Supplier names compared after normaliseSupplierName (drops 'Pty Ltd', case, punctuation).",
        ),
      ),
      said(
        "Requiring a matching ABN, with a test for pair 14.",
        edit(
          at("apps/api/src/invoices/dedupe.ts"),
          "sameSupplier(a, b) && sameAmount(a, b)",
          "a.supplierAbn === b.supplierAbn && sameAmount(a, b)",
        ),
        edit(
          at("apps/api/src/invoices/dedupe.test.ts"),
          `describe("isDuplicate", () => {`,
          `describe("isDuplicate", () => {\n  it("does not pair suppliers with different ABNs (pair 14)", () => expect(isDuplicate(inv20502, inv20577)).toBe(false));`,
        ),
      ),
      said(
        "Testing and committing.",
        bash(
          "pnpm test apps/api/src/invoices/dedupe && git commit -qam 'fix(dedupe): pairs need the same supplier ABN' && git log --oneline -1",
          " Tests 9 passed (9)\n2a7c5d1 fix(dedupe): pairs need the same supplier ABN",
        ),
      ),
      said(
        "Done: pairs now need the same supplier ABN, so pair 14 no longer matches. Commit `2a7c5d1`. Ready for pair 15.",
      ),
      humanInChild(
        "Good. The supplier-name normaliser needs a proper rewrite too, but that's its own job. Get the parent to delegate it out, and we can keep going through the pairs here.",
      ),
    ],
    check: {
      kind: "notifies",
      parentId: DUPES_ROOT,
      quotes: [
        "needs a proper rewrite",
        "its own job",
        "delegate it out",
        "keep going through the pairs",
      ],
    },
  },
  {
    id: "finished-child-material",
    kind: "bad",
    base: "fails",
    source: FINISHED_CHILD,
    role: "coder",
    threadId: CSV_CODER,
    parentId: CSV_ROOT,
    engagedTools: engagedChildTools(),
    messages: [
      ...csvCoderFinished(),
      humanInChild(
        "Call the column `currency_code`, not `currency`: the finance importer expects ISO codes under that name. Update the report too.",
      ),
      said(
        "Renaming the column.",
        edit(CSV_PATH, `"total", "currency"]`, `"total", "currency_code"]`),
      ),
      said(
        "Testing and committing.",
        bash(
          "pnpm test apps/api/src/export && git commit -qam 'fix(export): name the column currency_code' && git log --oneline -1",
          " Tests 15 passed (15)\n9e02b6f fix(export): name the column currency_code",
        ),
      ),
      said(
        "Updating the report.",
        finishedSubmit(
          CSV_REPORT.replaceAll("`currency`", "`currency_code`").replace(
            "Commit `4be19c2`.",
            "Commits `4be19c2`, `9e02b6f` (column renamed at the human's request).",
          ),
        ),
      ),
    ],
    check: {
      kind: "notifies",
      parentId: CSV_ROOT,
      quotes: ["finance importer expects", "not `currency`", "not currency"],
    },
  },
  {
    id: "finished-child-tidy",
    kind: "control",
    base: "passes",
    source: `${FINISHED_CHILD} The human, 10 Nov: "I've asked the agent to clarify something in the report, and then it has taken it upon itself to update the report".`,
    role: "coder",
    threadId: CSV_CODER,
    parentId: CSV_ROOT,
    engagedTools: engagedChildTools(),
    messages: [
      ...csvCoderFinished(true),
      humanInChild("What does 'rows are now currency-stable' mean in your report?"),
      said(
        "It means re-exporting the same invoice always gives each row the same currency: the column is the invoice's own `currency`, an ISO 4217 code set when the invoice is issued and never changed afterwards. I'll reword the report to say that plainly.",
        finishedSubmit(
          CSV_REPORT.replace(
            "Rows are now currency-stable: a re-export never changes a row's currency.",
            "Each row's currency is the invoice's own ISO 4217 code, set when the invoice is issued, so re-exporting an invoice never changes it.",
          ),
        ),
      ),
    ],
    check: { kind: "none-of", plainSubmit: false, tools: ["notify_thread"] },
  },
  {
    id: "finished-child-delegate",
    kind: "bad",
    base: "fails",
    source: `${FINISHED_CHILD} The human: "Get the parent to delegate out this work, and we can continue going through the results."`,
    role: "coder",
    threadId: CSV_CODER,
    parentId: CSV_ROOT,
    engagedTools: engagedChildTools(),
    messages: [
      ...csvCoderFinished(),
      humanInChild(
        "The PDF export has the same currency bug. Get the parent to delegate that out as its own fix.",
      ),
    ],
    check: {
      kind: "notifies",
      parentId: CSV_ROOT,
      quotes: ["same currency bug", "delegate that out", "its own fix"],
    },
  },
  {
    id: "working-child-question",
    kind: "control",
    base: "passes",
    source:
      "The human asking a working child a question (intent brief, must-not: 'wake the parent because you asked a child a question').",
    role: "coder",
    threadId: "thread:acme-coder-4c62",
    parentId: CSV_ROOT,
    engagedTools: engagedChildTools(),
    messages: [
      kickoff(
        "coder",
        `# Re-render archived invoice PDFs with the new template

Re-render the 1,200 archived invoice PDFs in \`${at("storage/invoices/2025/")}\` with the template from #426, using \`${at("scripts/rerender.ts")}\`. Spot-check ten, then report how many rendered and any failures.`,
      ),
      said(
        "Checking the script's options.",
        bash(
          "pnpm tsx scripts/rerender.ts --help",
          "Usage: rerender.ts <dir> [--concurrency n] (default 1)",
        ),
      ),
      said(
        "Starting the run, one at a time.",
        bash(
          "pnpm tsx scripts/rerender.ts storage/invoices/2025 --concurrency 1 | tail -2",
          "rendered 180/1200\nrendered 200/1200",
        ),
      ),
      humanInChild("Why are you rendering these one at a time rather than in parallel?"),
    ],
    check: { kind: "none-of", plainSubmit: false, tools: ["notify_thread"] },
  },
];
