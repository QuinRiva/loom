// @effect-diagnostics nodeBuiltinImport:off - source-level invariant check; reads repo files, no Effect runtime here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The composer is always a composer — the *prop boundary* pinned at source level.
 *
 * These are absence invariants about wiring that produces no rendered output, so
 * there is nothing to drive in a DOM: the point is that `ChatComposer` is not
 * given the question's answer state in the first place, and that no branch
 * precedes `isRunning` in the primary actions. Each corresponds to a hard lock
 * from the client audit's S9 catalogue, deleted rather than repaired:
 *
 * - the editor value swap and the `onPromptChange` reroute (S3): the composer's
 *   value and `promptRef` no longer have a second meaning while a question is up,
 *   so the `promptRef`/draft desync is unreachable rather than patched;
 * - the Enter hijack in `onSend` (S4's composer half);
 * - the pending branch that preceded `isRunning` (S2): the stop button is never
 *   removed from the DOM.
 *
 * Scope note: matching source text catches a path being *restored*, not the same
 * hazard *rebuilt* under different names. The behavioural half of S4 — that no
 * unaimed keystroke can select, submit, or dismiss, whatever mechanism is used —
 * is asserted against a real DOM in `pendingQuestionKeyboardSafety.test.tsx`, and
 * that is the test to extend when the concern is behaviour rather than wiring.
 */
const SRC = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath: string): string =>
  NodeFS.readFileSync(NodePath.join(SRC, relativePath), "utf8");

const CHAT_COMPOSER = "components/chat/ChatComposer.tsx";
const CHAT_VIEW = "components/ChatView.tsx";
const PRIMARY_ACTIONS = "components/chat/ComposerPrimaryActions.tsx";
const CARD = "components/chat/PendingQuestionCard.tsx";

describe("the composer never answers a question", () => {
  it("does not reroute keystrokes, re-value the editor, or otherwise read a question's answer state", () => {
    const composer = read(CHAT_COMPOSER);

    // The takeover was expressed entirely through this per-question progress
    // object. The composer no longer receives it at all — it takes only a
    // pre-rendered card node and a boolean for header spacing.
    expect(composer).not.toContain("activePendingProgress");
    expect(composer).not.toContain("customAnswer");
    expect(composer).not.toContain("onChangeActivePendingUserInputCustomAnswer");
    expect(composer).not.toContain("onAdvanceActivePendingUserInput");
    expect(composer).toContain("pendingQuestionCard");
  });

  it("does not hijack Enter into submitting an answer", () => {
    const chatView = read(CHAT_VIEW);

    // `onSend`'s second statement used to be an early return into the question's
    // submit. A plain send is now a supersede, handled by the server.
    expect(chatView).not.toContain("onAdvanceActivePendingUserInput");
    expect(chatView).toContain("supersedingRequestIds");
  });

  it("registers no global key listener and no timed dispatch in the question UI", () => {
    const card = read(CARD);

    // A cheap corroboration of the behavioural guarantee, not the guarantee
    // itself: these are the shapes the deleted listener used, and their absence
    // is worth stating where a reader of this file will look for it. The actual
    // invariant — that an unaimed keystroke reaches no callback by ANY mechanism —
    // is proven in `pendingQuestionKeyboardSafety.test.tsx`.
    expect(card).not.toContain("addEventListener");
    expect(card).not.toContain("setTimeout");
    expect(card).not.toContain("queueMicrotask");
  });

  it("keeps the stop button structurally reachable: no branch precedes the isRunning branch", () => {
    const primaryActions = read(PRIMARY_ACTIONS);

    expect(primaryActions).not.toContain("pendingAction");
    const firstBranch = primaryActions.indexOf("  if (");
    expect(primaryActions.slice(firstBranch)).toMatch(/^ {2}if \(isRunning\)/);
  });

  it("suppresses no attachments or contexts while a question is open", () => {
    const composer = read(CHAT_COMPOSER);

    // Images/terminal contexts/review comments/annotations were all hidden or
    // refused during a question. They are unrelated to answering and stay.
    expect(composer).not.toContain("pendingUserInputs.length === 0");
    expect(composer).not.toContain("Attach images after answering plan questions");
  });
});
