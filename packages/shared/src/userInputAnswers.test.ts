import type { UserInputQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUserInputAnswers,
  countAnsweredUserInputQuestions,
  isUsingCustomUserInputAnswer,
  resolveUserInputAnswer,
  selectedUserInputOptionLabels,
  setUserInputCustomAnswer,
  toggleUserInputOptionSelection,
  userInputAnswerDraftsOf,
  withResolvedUserInputDraftsEvicted,
  withToggledUserInputOption,
  withUserInputCustomAnswer,
  type UserInputAnswerDraftEntries,
} from "./userInputAnswers.ts";

const singleSelect: UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "Client-first", description: "Focus on the clients first" },
  ],
  multiSelect: false,
};

const multiSelect: UserInputQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
    { label: "Mobile", description: "Mobile" },
  ],
  multiSelect: true,
};

describe("resolveUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolveUserInputAnswer(singleSelect, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "  Something else  ",
      }),
    ).toBe("Something else");
  });

  it("ignores whitespace-only custom answers", () => {
    expect(
      resolveUserInputAnswer(singleSelect, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "   ",
      }),
    ).toBe("Orchestration-first");
  });

  it("returns every selected label for a multi-select question", () => {
    expect(
      resolveUserInputAnswer(multiSelect, { selectedOptionLabels: ["Server", "Web"] }),
    ).toEqual(["Server", "Web"]);
  });

  it("returns null while unanswered", () => {
    expect(resolveUserInputAnswer(multiSelect, undefined)).toBeNull();
    expect(resolveUserInputAnswer(singleSelect, { selectedOptionLabels: [] })).toBeNull();
  });
});

describe("toggleUserInputOptionSelection", () => {
  it("replaces the selection for a single-select question", () => {
    const first = toggleUserInputOptionSelection(singleSelect, undefined, "Orchestration-first");
    expect(toggleUserInputOptionSelection(singleSelect, first, "Client-first")).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Client-first"],
    });
  });

  it("accumulates and removes selections for a multi-select question", () => {
    const server = toggleUserInputOptionSelection(multiSelect, undefined, "Server");
    const serverAndWeb = toggleUserInputOptionSelection(multiSelect, server, "Web");
    expect(serverAndWeb.selectedOptionLabels).toEqual(["Server", "Web"]);

    const webOnly = toggleUserInputOptionSelection(multiSelect, serverAndWeb, "Server");
    expect(webOnly.selectedOptionLabels).toEqual(["Web"]);

    expect(
      toggleUserInputOptionSelection(multiSelect, webOnly, "Web").selectedOptionLabels,
    ).toBeUndefined();
  });

  it("clears a custom answer when an option is chosen", () => {
    expect(
      toggleUserInputOptionSelection(multiSelect, { customAnswer: "typed instead" }, "Mobile")
        .customAnswer,
    ).toBe("");
  });
});

describe("setUserInputCustomAnswer", () => {
  it("drops the selection once free text takes over", () => {
    const typed = setUserInputCustomAnswer({ selectedOptionLabels: ["Server", "Web"] }, "custom");
    expect(typed.selectedOptionLabels).toBeUndefined();
    expect(resolveUserInputAnswer(multiSelect, typed)).toBe("custom");
  });

  it("keeps an existing selection when the field is edited but still empty", () => {
    const kept = setUserInputCustomAnswer({ selectedOptionLabels: ["Server"] }, "   ");
    expect(resolveUserInputAnswer(multiSelect, kept)).toEqual(["Server"]);
  });
});

describe("buildUserInputAnswers", () => {
  it("returns null until every question is answered", () => {
    expect(
      buildUserInputAnswers([singleSelect, multiSelect], {
        scope: { selectedOptionLabels: ["Orchestration-first"] },
      }),
    ).toBeNull();
  });

  it("carries a multi-select answer as an array, never truncated to one label", () => {
    expect(
      buildUserInputAnswers([singleSelect, multiSelect], {
        scope: { selectedOptionLabels: ["Orchestration-first"] },
        areas: { selectedOptionLabels: ["Server", "Web", "Mobile"] },
      }),
    ).toEqual({
      scope: "Orchestration-first",
      areas: ["Server", "Web", "Mobile"],
    });
  });
});

describe("draft inspection helpers", () => {
  it("reports custom-answer usage and normalised selections", () => {
    expect(isUsingCustomUserInputAnswer({ customAnswer: " x " })).toBe(true);
    expect(isUsingCustomUserInputAnswer({ customAnswer: "  " })).toBe(false);
    expect(selectedUserInputOptionLabels({ selectedOptionLabels: ["a", "a", " "] })).toEqual(["a"]);
  });

  it("counts answered questions", () => {
    expect(
      countAnsweredUserInputQuestions([singleSelect, multiSelect], {
        areas: { selectedOptionLabels: ["Server"] },
      }),
    ).toBe(1);
  });
});

/**
 * The draft collection's transitions, and above all its eviction rule — the rule
 * both clients now share because two hand-written copies diverged: mobile's
 * evicted by environment prefix against the SELECTED thread's open set, so
 * switching away from a thread with a partial answer deleted it.
 */
describe("the answer-draft collection", () => {
  const threadA = "env-1:thread-a";
  const threadB = "env-1:thread-b";
  const requestA = "env-1:req-a";
  const requestB = "env-1:req-b";

  const withDraftsOn = (): UserInputAnswerDraftEntries => {
    let entries: UserInputAnswerDraftEntries = {};
    entries = withToggledUserInputOption(entries, {
      requestKey: requestA,
      threadKey: threadA,
      question: multiSelect,
      optionLabel: "Server",
    });
    entries = withUserInputCustomAnswer(entries, {
      requestKey: requestB,
      threadKey: threadB,
      questionId: singleSelect.id,
      customAnswer: "half-typed answer on the other thread",
    });
    return entries;
  };

  it("keeps each request's answers under its own key, tagged with its owning thread", () => {
    const entries = withDraftsOn();

    expect(entries[requestA]?.threadKey).toBe(threadA);
    expect(userInputAnswerDraftsOf(entries, requestA).areas?.selectedOptionLabels).toEqual([
      "Server",
    ]);
    expect(userInputAnswerDraftsOf(entries, requestB).scope?.customAnswer).toBe(
      "half-typed answer on the other thread",
    );
    expect(userInputAnswerDraftsOf(entries, null)).toEqual({});
    expect(userInputAnswerDraftsOf(entries, "env-1:never-seen")).toEqual({});
  });

  it("evicts the reporting thread's resolved request without touching another thread's draft", () => {
    // Thread A is on screen with nothing open (its request just resolved). Thread B
    // is not on screen at all, so A's open set says nothing about B.
    const next = withResolvedUserInputDraftsEvicted(withDraftsOn(), {
      threadKey: threadA,
      openRequestKeys: new Set<string>(),
    });

    expect(next[requestA]).toBeUndefined();
    expect(userInputAnswerDraftsOf(next, requestB).scope?.customAnswer).toBe(
      "half-typed answer on the other thread",
    );
  });

  it("survives a thread switch: selecting a thread with no open requests keeps the other's draft", () => {
    let entries = withDraftsOn();
    // The switch itself: thread A becomes selected and reports its (empty) open set.
    entries = withResolvedUserInputDraftsEvicted(entries, {
      threadKey: threadA,
      openRequestKeys: new Set<string>(),
    });
    // Switching back to B, whose request is still open, must find the draft intact.
    entries = withResolvedUserInputDraftsEvicted(entries, {
      threadKey: threadB,
      openRequestKeys: new Set([requestB]),
    });

    expect(userInputAnswerDraftsOf(entries, requestB).scope?.customAnswer).toBe(
      "half-typed answer on the other thread",
    );
  });

  it("evicts on any outcome, including the startup scan's cancelled, because it reads the open set not the outcome", () => {
    // A `resolved{cancelled}` from boot reconciliation removes the request from the
    // derived open set exactly as an answer or a dismissal does; the rule cannot
    // tell them apart, which is the point — no outcome is special-cased.
    const next = withResolvedUserInputDraftsEvicted(withDraftsOn(), {
      threadKey: threadB,
      openRequestKeys: new Set<string>(),
    });

    expect(next[requestB]).toBeUndefined();
    expect(userInputAnswerDraftsOf(next, requestA).areas?.selectedOptionLabels).toEqual(["Server"]);
  });

  it("returns the same reference when nothing is stale, so subscribers do not re-render", () => {
    const entries = withDraftsOn();

    expect(
      withResolvedUserInputDraftsEvicted(entries, {
        threadKey: threadA,
        openRequestKeys: new Set([requestA]),
      }),
    ).toBe(entries);
    // A thread with no drafts at all reports its open set on every render.
    expect(
      withResolvedUserInputDraftsEvicted(entries, {
        threadKey: "env-1:thread-c",
        openRequestKeys: new Set<string>(),
      }),
    ).toBe(entries);
  });
});
