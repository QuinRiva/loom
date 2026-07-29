// @vitest-environment jsdom
import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import type { UserInputAnswerDraft } from "@t3tools/shared/userInputAnswers";
import {
  buildUserInputAnswers,
  setUserInputCustomAnswer,
  toggleUserInputOptionSelection,
} from "@t3tools/shared/userInputAnswers";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { PendingQuestionCard, type PendingQuestionCardProps } from "./PendingQuestionCard";

const question = (overrides?: Partial<UserInputQuestion>): UserInputQuestion => ({
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "Client-first", description: "Focus on the clients first", recommended: true },
  ],
  multiSelect: false,
  ...overrides,
});

const THREE_QUESTIONS: ReadonlyArray<UserInputQuestion> = [
  question(),
  question({ id: "compat", header: "Compat", question: "How strict should compatibility be?" }),
  question({ id: "rollout", header: "Rollout", question: "Ship behind a flag?" }),
];

/**
 * Whether the button carrying `marker` renders the `disabled` attribute. Matched
 * as `disabled=""` specifically — the Tailwind class list is full of
 * `disabled:`/`not-disabled:` variant names that a substring check would hit.
 */
const isDisabled = (markup: string, marker: string): boolean => {
  const index = markup.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  const tagStart = markup.lastIndexOf("<button", index);
  return markup.slice(tagStart, markup.indexOf(">", index)).includes('disabled=""');
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const REQUEST_ID = ApprovalRequestId.make("req-1");

const render = (overrides?: Partial<PendingQuestionCardProps>): string => {
  act(() => {
    root.render(
      <PendingQuestionCard
        pendingUserInput={{
          requestId: REQUEST_ID,
          createdAt: "2026-07-29T00:00:00.000Z",
          questions: [question()],
        }}
        pendingCount={1}
        drafts={{}}
        answers={null}
        isResponding={false}
        isDismissing={false}
        supersededByMessage={false}
        onToggleOption={() => {}}
        onChangeCustomAnswer={() => {}}
        onSubmit={() => {}}
        onDismiss={() => {}}
        {...overrides}
      />,
    );
  });
  return container.innerHTML;
};

/**
 * The card driven the way `ChatView` drives it: drafts held outside the card and
 * updated through the shared transitions, so answering really re-renders the card
 * with a new answer rather than being faked with a fixed prop.
 */
function LiveCard({
  questions,
  initialDrafts,
}: {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly initialDrafts: Record<string, UserInputAnswerDraft>;
}) {
  const [drafts, setDrafts] = useState<Record<string, UserInputAnswerDraft>>(initialDrafts);

  return (
    <PendingQuestionCard
      pendingUserInput={{ requestId: REQUEST_ID, createdAt: "2026-07-29T00:00:00.000Z", questions }}
      pendingCount={1}
      drafts={drafts}
      answers={buildUserInputAnswers(questions, drafts)}
      isResponding={false}
      isDismissing={false}
      supersededByMessage={false}
      onToggleOption={(target, optionLabel) =>
        setDrafts((current) => ({
          ...current,
          [target.id]: toggleUserInputOptionSelection(target, current[target.id], optionLabel),
        }))
      }
      onChangeCustomAnswer={(questionId, customAnswer) =>
        setDrafts((current) => ({
          ...current,
          [questionId]: setUserInputCustomAnswer(current[questionId], customAnswer),
        }))
      }
      onSubmit={() => {}}
      onDismiss={() => {}}
    />
  );
}

const mountLive = (
  questions: ReadonlyArray<UserInputQuestion>,
  initialDrafts: Record<string, UserInputAnswerDraft> = {},
) => {
  act(() => {
    root.render(<LiveCard questions={questions} initialDrafts={initialDrafts} />);
  });
};

const expandedQuestionIds = (): ReadonlyArray<string> =>
  [...container.querySelectorAll<HTMLElement>('[data-pending-question-expanded="true"]')].map(
    (element) => element.dataset.pendingQuestion ?? "",
  );

const questionIds = (): ReadonlyArray<string> =>
  [...container.querySelectorAll<HTMLElement>("[data-pending-question]")].map(
    (element) => element.dataset.pendingQuestion ?? "",
  );

const summaryOf = (questionId: string): string | null =>
  container
    .querySelector<HTMLElement>(`[data-pending-question-summary="${questionId}"]`)
    ?.textContent?.trim() ?? null;

const click = (selector: string) => {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  act(() => element?.click());
};

/**
 * Type into the card's free-text field the way a user does. React installs its own
 * `value` setter on the node to dedupe changes, so assigning `.value` directly is
 * invisible to it — the native setter has to be called explicitly.
 */
const typeCustomAnswer = (text: string) => {
  const field = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(field).not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    if (field && setValue) {
      setValue.call(field, text);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
  });
};

const clickOption = (label: string) => {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.dataset.pendingQuestionHeader === undefined &&
      candidate.getAttribute("aria-pressed") !== null &&
      candidate.textContent?.includes(label) === true,
  );
  expect(button, label).not.toBeUndefined();
  act(() => button?.click());
};

describe("PendingQuestionCard", () => {
  it("is self-contained: options, stakes, recommendation, its own free-text field, submit and dismiss", () => {
    const markup = render({
      pendingUserInput: {
        requestId: REQUEST_ID,
        createdAt: "2026-07-29T00:00:00.000Z",
        questions: [question({ stakes: "Getting this wrong costs a migration." })],
      },
    });

    expect(markup).toContain("Orchestration-first");
    expect(markup).toContain("Getting this wrong costs a migration.");
    expect(markup).toContain("Suggested");
    expect(markup).toContain("Submit answer");
    expect(markup).toContain("Dismiss");

    // The free-text field starts behind a compact affordance rather than as an
    // always-open textarea — three of those were a third of the old card's height.
    expect(container.querySelector("textarea")).toBeNull();
    click('[data-pending-question-custom-answer-open="scope"]');
    expect(container.innerHTML).toContain('aria-label="Custom answer for Scope"');
  });

  it("always offers a way out: dismiss stays enabled with nothing answered", () => {
    expect(isDisabled(render(), "data-pending-question-dismiss")).toBe(false);
  });

  it("gates submit on a complete answer set, never on a partial one", () => {
    expect(isDisabled(render({ answers: null }), "data-pending-question-submit")).toBe(true);
    expect(
      isDisabled(
        render({ answers: { scope: "Orchestration-first" } }),
        "data-pending-question-submit",
      ),
    ).toBe(false);
  });

  it("disables both controls while a submission or dismissal is in flight, never hiding either", () => {
    const responding = render({ answers: { scope: "x" }, isResponding: true });
    expect(responding).toContain("Submitting...");
    expect(isDisabled(responding, "data-pending-question-dismiss")).toBe(true);

    const dismissing = render({ answers: { scope: "x" }, isDismissing: true });
    expect(dismissing).toContain("Dismissing...");
    expect(isDisabled(dismissing, "data-pending-question-submit")).toBe(true);
  });

  it("surfaces additional open requests rather than hiding them behind the first (S8)", () => {
    expect(render({ pendingCount: 3 })).toContain("2 more pending");
    expect(render({ pendingCount: 1 })).not.toContain("more pending");
  });

  it("resolves visibly when a plain message superseded the question, rather than vanishing", () => {
    const markup = render({ supersededByMessage: true });

    expect(markup).toContain("Answered by your message");
    expect(markup).toContain("Your message was delivered as the response");
    // No answering controls survive: the question is settled server-side.
    expect(markup).not.toContain("Submit answer");
    expect(markup).not.toContain("Dismiss");
    expect(markup).not.toContain("Orchestration-first");
  });

  it("offers no keyboard shortcut affordance, because no keystroke path selects an option", () => {
    const markup = render();

    // The deleted document-level digit listener advertised itself with <kbd>1</kbd>
    // hints on each option. Their absence is the visible half of that deletion;
    // takeoverDeleted.test.ts pins the code half.
    expect(markup).not.toContain("<kbd");
  });
});

describe("the accordion: a question at a time, none of them hidden", () => {
  it("expands exactly one question of a three-question request, the first unanswered", () => {
    mountLive(THREE_QUESTIONS);

    expect(questionIds()).toEqual(["scope", "compat", "rollout"]);
    expect(expandedQuestionIds()).toEqual(["scope"]);
    // Nothing hidden: the collapsed questions keep a header row with their text.
    expect(summaryOf("compat")).toBe("How strict should compatibility be?");
    expect(summaryOf("rollout")).toBe("Ship behind a flag?");
    // Only the expanded question renders its option list.
    expect(container.querySelectorAll("[aria-pressed]")).toHaveLength(2);
  });

  it("re-derives the expansion from the drafts, so a partial answer that survived a thread switch resumes where it left off", () => {
    mountLive(THREE_QUESTIONS, { scope: { selectedOptionLabels: ["Client-first"] } });

    expect(expandedQuestionIds()).toEqual(["compat"]);
    expect(summaryOf("scope")).toBe("Client-first");
  });

  it("collapses an answered question to a summary of the answer and expands the next unanswered one", () => {
    mountLive(THREE_QUESTIONS);

    clickOption("Orchestration-first");

    expect(expandedQuestionIds()).toEqual(["compat"]);
    expect(summaryOf("scope")).toBe("Orchestration-first");
    // Distinct from an unanswered row, which the reader must be able to tell apart.
    expect(
      container.querySelector<HTMLElement>('[data-pending-question="scope"]')?.dataset
        .pendingQuestionAnswered,
    ).toBe("true");
    expect(
      container.querySelector<HTMLElement>('[data-pending-question="rollout"]')?.dataset
        .pendingQuestionAnswered,
    ).toBe("false");
  });

  it("collapses everything to summaries once nothing is left unanswered, leaving submit as the next action", () => {
    mountLive(THREE_QUESTIONS);

    clickOption("Orchestration-first");
    clickOption("Client-first");
    clickOption("Orchestration-first");

    expect(expandedQuestionIds()).toEqual([]);
    expect([summaryOf("scope"), summaryOf("compat"), summaryOf("rollout")]).toEqual([
      "Orchestration-first",
      "Client-first",
      "Orchestration-first",
    ]);
    expect(isDisabled(container.innerHTML, "data-pending-question-submit")).toBe(false);
  });

  it("reopens an answered question on its header row and lets the answer be changed", () => {
    mountLive(THREE_QUESTIONS);

    clickOption("Orchestration-first");
    click('[data-pending-question-header="scope"]');

    expect(expandedQuestionIds()).toEqual(["scope"]);
    // The current selection is visible and editable.
    const pressed = [...container.querySelectorAll<HTMLElement>('[aria-pressed="true"]')].map(
      (element) => element.textContent,
    );
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain("Orchestration-first");

    clickOption("Client-first");
    expect(summaryOf("scope")).toBe("Client-first");
  });

  it("moves the expansion rather than opening a second question when a header is clicked", () => {
    mountLive(THREE_QUESTIONS);

    click('[data-pending-question-header="rollout"]');

    expect(expandedQuestionIds()).toEqual(["rollout"]);
  });

  it("keeps a multi-select question open across toggles and advances only on an explicit confirm", () => {
    const questions = [
      question({ id: "targets", header: "Targets", multiSelect: true }),
      question({ id: "compat", header: "Compat" }),
    ];
    mountLive(questions);

    clickOption("Orchestration-first");
    expect(expandedQuestionIds()).toEqual(["targets"]);
    clickOption("Client-first");
    expect(expandedQuestionIds()).toEqual(["targets"]);

    click('[data-pending-question-confirm="targets"]');

    expect(expandedQuestionIds()).toEqual(["compat"]);
    expect(summaryOf("targets")).toBe("Orchestration-first, Client-first");
  });

  it("keeps a custom answer expanded while it is typed and summarises it once committed", () => {
    mountLive(THREE_QUESTIONS);

    click('[data-pending-question-custom-answer-open="scope"]');
    typeCustomAnswer("Neither — split the work");

    // Typing does not steal the surface away mid-sentence.
    expect(expandedQuestionIds()).toEqual(["scope"]);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Neither — split the work",
    );

    click('[data-pending-question-confirm="scope"]');

    expect(expandedQuestionIds()).toEqual(["compat"]);
    expect(summaryOf("scope")).toBe("Neither — split the work");
  });

  it("is operable by keyboard: every header is a focusable button carrying its expanded state", () => {
    mountLive(THREE_QUESTIONS);

    const headers = [
      ...container.querySelectorAll<HTMLElement>("[data-pending-question-header]"),
    ].map((element) => ({
      tag: element.tagName,
      expanded: element.getAttribute("aria-expanded"),
      disabled: element.hasAttribute("disabled"),
    }));

    expect(headers).toEqual([
      { tag: "BUTTON", expanded: "true", disabled: false },
      { tag: "BUTTON", expanded: "false", disabled: false },
      { tag: "BUTTON", expanded: "false", disabled: false },
    ]);

    // A focused header activated by the keyboard fires a click, which is the whole
    // keyboard path — no global listener is involved (S4 stays deleted).
    const rollout = container.querySelector<HTMLButtonElement>(
      '[data-pending-question-header="rollout"]',
    );
    rollout?.focus();
    expect(document.activeElement).toBe(rollout);
    act(() => rollout?.click());
    expect(expandedQuestionIds()).toEqual(["rollout"]);
  });

  it("keeps submit and dismiss present and enabled in every accordion state", () => {
    mountLive(THREE_QUESTIONS);

    const controlsPresent = () => {
      expect(container.querySelector("[data-pending-question-submit]")).not.toBeNull();
      expect(isDisabled(container.innerHTML, "data-pending-question-dismiss")).toBe(false);
    };

    controlsPresent();
    clickOption("Orchestration-first"); // one answered, second expanded
    controlsPresent();
    click('[data-pending-question-header="rollout"]'); // an unanswered one reopened out of order
    controlsPresent();
    clickOption("Client-first");
    clickOption("Orchestration-first"); // all answered, all collapsed
    controlsPresent();
    expect(expandedQuestionIds()).toEqual([]);
  });

  it("renders a lone question expanded with no disclosure control, since there is nothing to collapse for", () => {
    mountLive([question()]);

    expect(expandedQuestionIds()).toEqual(["scope"]);
    expect(container.querySelector("[data-pending-question-header]")).toBeNull();
    expect(container.querySelector("[data-pending-question-confirm]")).toBeNull();
  });
});
