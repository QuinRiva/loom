import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

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

const render = (overrides?: Partial<PendingQuestionCardProps>) =>
  renderToStaticMarkup(
    <PendingQuestionCard
      pendingUserInput={{
        requestId: ApprovalRequestId.make("req-1"),
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

describe("PendingQuestionCard", () => {
  it("is self-contained: options, stakes, recommendation, its own free-text field, submit and dismiss", () => {
    const markup = render({
      pendingUserInput: {
        requestId: ApprovalRequestId.make("req-1"),
        createdAt: "2026-07-29T00:00:00.000Z",
        questions: [question({ stakes: "Getting this wrong costs a migration." })],
      },
    });

    expect(markup).toContain("Orchestration-first");
    expect(markup).toContain("Getting this wrong costs a migration.");
    expect(markup).toContain("Suggested");
    expect(markup).toContain('aria-label="Custom answer for Scope"');
    expect(markup).toContain("Submit answer");
    expect(markup).toContain("Dismiss");
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

  it("renders every question of a multi-question request at once, so no step can be skipped past", () => {
    const markup = render({
      pendingUserInput: {
        requestId: ApprovalRequestId.make("req-1"),
        createdAt: "2026-07-29T00:00:00.000Z",
        questions: [
          question(),
          question({ id: "compat", header: "Compat", question: "How strict?" }),
        ],
      },
    });

    expect(markup).toContain('aria-label="Custom answer for Scope"');
    expect(markup).toContain('aria-label="Custom answer for Compat"');
    expect(markup).toContain("Submit answers");
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
