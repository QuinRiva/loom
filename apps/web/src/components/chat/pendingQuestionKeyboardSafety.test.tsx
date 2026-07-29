// @vitest-environment jsdom
import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { PendingQuestionCard } from "./PendingQuestionCard";

/**
 * The S4 invariant, asserted behaviourally: **no keystroke the user did not aim
 * at a control can select an option, submit an answer, or dismiss a question.**
 *
 * The deleted implementation registered a `document`-level keydown listener that
 * mapped digits 1-9 to options and, for single-select, committed and auto-advanced
 * after 200 ms — so a stray digit typed with focus on the page body could dispatch
 * an answer the user never chose. A source-level check for that code's exact
 * spellings would not notice the same hazard rebuilt with `window.addEventListener`,
 * a React `onKeyDown`, a helper in another file, or a `queueMicrotask` dispatch.
 * So this test drives the real DOM and watches the callbacks instead: whatever the
 * mechanism, an unaimed keystroke must reach none of them.
 *
 * `composerQuestionIsolation.test.ts` remains the complement — it pins that the
 * COMPOSER cannot reach the question's state at all, which is a property of the
 * prop boundary rather than of any rendered output.
 */
const question: UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Orchestration" },
    { label: "Client-first", description: "Clients" },
    { label: "Both", description: "Both at once" },
  ],
  multiSelect: false,
};

interface Calls {
  toggles: Array<string>;
  submits: number;
  dismissals: number;
  customAnswers: Array<string>;
}

let container: HTMLDivElement;
let root: Root;
let calls: Calls;

const mountCard = (overrides?: { multiSelect?: boolean; answers?: Record<string, string> }) => {
  const rendered: UserInputQuestion = overrides?.multiSelect
    ? { ...question, multiSelect: true }
    : question;
  act(() => {
    root.render(
      <PendingQuestionCard
        pendingUserInput={{
          requestId: ApprovalRequestId.make("req-keyboard"),
          createdAt: "2026-07-29T00:00:00.000Z",
          questions: [rendered],
        }}
        pendingCount={1}
        drafts={{}}
        answers={overrides?.answers ?? null}
        isResponding={false}
        isDismissing={false}
        supersededByMessage={false}
        onToggleOption={(_question, optionLabel) => calls.toggles.push(optionLabel)}
        onChangeCustomAnswer={(_questionId, value) => calls.customAnswers.push(value)}
        onSubmit={() => {
          calls.submits += 1;
        }}
        onDismiss={() => {
          calls.dismissals += 1;
        }}
      />,
    );
  });
};

const pressKey = (key: string, target: EventTarget) => {
  act(() => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
};

beforeEach(() => {
  calls = { toggles: [], submits: 0, dismissals: 0, customAnswers: [] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("no keystroke can answer a question the user did not aim at a control", () => {
  it("ignores digits pressed with focus on the page body", () => {
    mountCard();

    for (const key of ["1", "2", "3", "9"]) {
      pressKey(key, document.body);
    }

    expect(calls).toEqual({ toggles: [], submits: 0, dismissals: 0, customAnswers: [] });
  });

  it("ignores digits dispatched at the document and at the card itself", () => {
    mountCard();
    const card = container.querySelector("[data-pending-question-card]");
    expect(card).not.toBeNull();

    pressKey("1", document);
    pressKey("1", card as Element);

    expect(calls.toggles).toEqual([]);
    expect(calls.submits).toBe(0);
  });

  it("ignores digits while an option button holds focus, the state right after a click", () => {
    mountCard();
    const optionButton = container.querySelector<HTMLButtonElement>(
      "[data-pending-question-card] button",
    );
    expect(optionButton).not.toBeNull();
    optionButton?.focus();

    pressKey("2", optionButton as Element);

    expect(calls.toggles).toEqual([]);
  });

  it("does not submit on Enter, even with a complete answer ready to send", () => {
    mountCard({ answers: { scope: "Orchestration-first" } });

    pressKey("Enter", document.body);
    pressKey("Enter", container.querySelector("[data-pending-question-card]") as Element);
    // The free-text field lives behind a compact affordance until asked for.
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-pending-question-custom-answer-open]")
        ?.click(),
    );
    const field = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(field).not.toBeNull();
    field?.focus();
    pressKey("Enter", field as Element);

    expect(calls.submits).toBe(0);
  });

  it("does not dispatch anything on a delay: nothing lands after timers would have fired", async () => {
    // The deleted listener committed 200 ms after a digit. Waiting well past that
    // catches a rebuilt auto-advance regardless of whether it uses setTimeout.
    mountCard();

    pressKey("1", document.body);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(calls).toEqual({ toggles: [], submits: 0, dismissals: 0, customAnswers: [] });
  });

  it("still answers when the user actually activates a control", () => {
    // The guard above must not be satisfied by a card that responds to nothing:
    // a real click selects, and the submit and dismiss controls both fire.
    mountCard({ answers: { scope: "Orchestration-first" } });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    const optionButton = buttons.find((button) =>
      button.textContent?.includes("Orchestration-first"),
    );
    act(() => optionButton?.click());
    expect(calls.toggles).toEqual(["Orchestration-first"]);

    act(() =>
      container.querySelector<HTMLButtonElement>("[data-pending-question-submit]")?.click(),
    );
    expect(calls.submits).toBe(1);

    act(() =>
      container.querySelector<HTMLButtonElement>("[data-pending-question-dismiss]")?.click(),
    );
    expect(calls.dismissals).toBe(1);
  });

  it("keeps keyboard activation of a focused control working, which is how the card stays accessible", () => {
    mountCard({ answers: { scope: "Orchestration-first" } });
    const submit = container.querySelector<HTMLButtonElement>("[data-pending-question-submit]");

    // A focused button activated by the keyboard fires a click — that is aimed
    // input and must keep working; only UNAIMED keystrokes are inert.
    act(() => submit?.click());

    expect(calls.submits).toBe(1);
  });
});
