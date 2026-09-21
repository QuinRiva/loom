import { describe, expect, it } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import {
  decideHandoffSend,
  decideRetroSend,
  runComposerDraftIntercept,
  shouldRestoreSubmittedDraft,
  HANDOFF_BLOCKED_CONTEXT_MESSAGE,
  HANDOFF_EMPTY_EXPLANATION_MESSAGE,
  RETRO_BLOCKED_CONTEXT_MESSAGE,
} from "./composerIntercepts";

describe("decideHandoffSend", () => {
  it("lets ordinary prompts fall through to a normal send", () => {
    expect(
      decideHandoffSend({ trimmedPrompt: "fix the retry logic", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "not-handoff" });
  });

  it("never falls through for a recognised /handoff (invariant: no turn-start)", () => {
    for (const prompt of ["/handoff", "/handoff out of scope", "  /handoff  x  "]) {
      expect(
        decideHandoffSend({ trimmedPrompt: prompt, hasAttachmentsOrContexts: false }).kind,
      ).not.toBe("not-handoff");
    }
  });

  it("reports the inline empty-explanation error without dispatching", () => {
    expect(
      decideHandoffSend({ trimmedPrompt: "/handoff", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "empty-error", message: HANDOFF_EMPTY_EXPLANATION_MESSAGE });
  });

  it("rejects a /handoff carrying attachments or contexts (MVP), never dispatching", () => {
    expect(
      decideHandoffSend({
        trimmedPrompt: "/handoff the retry logic is broken",
        hasAttachmentsOrContexts: true,
      }),
    ).toEqual({ kind: "blocked-context", message: HANDOFF_BLOCKED_CONTEXT_MESSAGE });
  });

  it("dispatches with the parsed explanation when clean", () => {
    expect(
      decideHandoffSend({
        trimmedPrompt: "/handoff the retry logic is broken",
        hasAttachmentsOrContexts: false,
      }),
    ).toEqual({ kind: "dispatch", explanation: "the retry logic is broken" });
  });
});

describe("decideRetroSend", () => {
  it("lets ordinary prompts fall through to a normal send", () => {
    expect(
      decideRetroSend({ trimmedPrompt: "review the process", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "not-retro" });
  });

  it("never falls through for a recognised /retro (invariant: no turn-start)", () => {
    for (const prompt of ["/retro", "/retro gate outcomes", "  /retro  x  "]) {
      expect(
        decideRetroSend({ trimmedPrompt: prompt, hasAttachmentsOrContexts: false }).kind,
      ).not.toBe("not-retro");
    }
  });

  it("dispatches a bare /retro with no focus (general review)", () => {
    expect(decideRetroSend({ trimmedPrompt: "/retro", hasAttachmentsOrContexts: false })).toEqual({
      kind: "dispatch",
      focus: undefined,
    });
  });

  it("rejects a /retro carrying attachments or contexts, never dispatching", () => {
    expect(
      decideRetroSend({ trimmedPrompt: "/retro the rework loop", hasAttachmentsOrContexts: true }),
    ).toEqual({ kind: "blocked-context", message: RETRO_BLOCKED_CONTEXT_MESSAGE });
  });

  it("dispatches with the parsed focus when clean", () => {
    expect(
      decideRetroSend({ trimmedPrompt: "/retro the rework loop", hasAttachmentsOrContexts: false }),
    ).toEqual({ kind: "dispatch", focus: "the rework loop" });
  });
});

describe("runComposerDraftIntercept", () => {
  // Minimal stand-in for the composer state `onSend` mutates: a prompt plus the
  // in-flight guard, driven through the same helper ChatView wires up.
  const createHarness = (options: {
    prompt: string;
    dispatch: () => Promise<AtomCommandResult<{ ok: true }, string>>;
  }) => {
    const state = {
      prompt: options.prompt,
      sendInFlight: false,
      dispatches: 0,
      successes: 0,
      failures: 0,
    };
    // Mirrors `onSend`: parse the composer's CURRENT content, bail unless it is
    // still a recognised draft command, then run the shared intercept.
    const submit = async () => {
      if (state.sendInFlight) return "guarded" as const;
      const decision = decideHandoffSend({
        trimmedPrompt: state.prompt.trim(),
        hasAttachmentsOrContexts: false,
      });
      if (decision.kind !== "dispatch") return decision.kind;
      return runComposerDraftIntercept({
        submittedPrompt: state.prompt,
        setSendInFlight: (inFlight) => {
          state.sendInFlight = inFlight;
        },
        clearComposer: () => {
          state.prompt = "";
        },
        readComposerContent: () => ({
          prompt: state.prompt,
          attachmentCount: 0,
          terminalContextCount: 0,
          previewAnnotationCount: 0,
          reviewCommentCount: 0,
          threadReferenceCount: 0,
        }),
        restoreComposer: (prompt) => {
          state.prompt = prompt;
        },
        dispatch: () => {
          state.dispatches += 1;
          return options.dispatch();
        },
        onSuccess: () => {
          state.successes += 1;
        },
        onFailure: () => {
          state.failures += 1;
        },
      });
    };
    return { state, submit };
  };

  const succeedAfterLatency = () =>
    new Promise<AtomCommandResult<{ ok: true }, string>>((resolve) => {
      setTimeout(() => resolve(AsyncResult.success({ ok: true } as const)), 5);
    });

  it("dispatches once for a burst of repeated submissions (the double-fire bug)", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: succeedAfterLatency,
    });

    // Eight synchronous presses while the first RPC is still in flight — the
    // shape that previously produced eight drafters and seven duplicate goals.
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => submit()));

    expect(state.dispatches).toBe(1);
    expect(state.successes).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1);
    expect(state.prompt).toBe("");
    expect(state.sendInFlight).toBe(false);
  });

  it("clears the composer before awaiting, so a re-entrant press has nothing to send", async () => {
    let observedPromptDuringDispatch: string | null = null;
    const harness = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () => {
        observedPromptDuringDispatch = harness.state.prompt;
        return succeedAfterLatency();
      },
    });

    await harness.submit();

    expect(observedPromptDuringDispatch).toBe("");
  });

  it("holds the in-flight guard across the await and releases it on success", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: succeedAfterLatency,
    });

    const pending = submit();
    expect(state.sendInFlight).toBe(true);
    await pending;
    expect(state.sendInFlight).toBe(false);
  });

  it("releases the guard and restores the draft when the RPC fails into an empty composer", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () =>
        Promise.resolve(AsyncResult.failure<{ ok: true }, string>(Cause.fail("nope"))),
    });

    expect(await submit()).toBe("failure");
    expect(state.failures).toBe(1);
    expect(state.prompt).toBe("/handoff extract the retry logic");
    expect(state.sendInFlight).toBe(false);

    // The restored draft is submittable again — one dispatch per deliberate press.
    expect(state.dispatches).toBe(1);
    expect(await submit()).toBe("failure");
    expect(state.dispatches).toBe(2);
  });

  it("never clobbers text the human typed while the failing RPC was in flight", async () => {
    const harness = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () => {
        harness.state.prompt = "a thought I had meanwhile";
        return Promise.resolve(AsyncResult.failure<{ ok: true }, string>(Cause.fail("nope")));
      },
    });

    expect(await harness.submit()).toBe("failure");
    expect(harness.state.prompt).toBe("a thought I had meanwhile");
  });

  it("releases the guard even when the dispatch throws", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: () => Promise.reject(new Error("transport exploded")),
    });

    await expect(submit()).rejects.toThrow("transport exploded");
    expect(state.sendInFlight).toBe(false);
  });

  it("is not reached at all while a send is already in flight (caller's entry guard)", async () => {
    const { state, submit } = createHarness({
      prompt: "/handoff extract the retry logic",
      dispatch: succeedAfterLatency,
    });
    state.sendInFlight = true;

    expect(await submit()).toBe("guarded");
    expect(state.dispatches).toBe(0);
  });
});

describe("shouldRestoreSubmittedDraft", () => {
  const emptyComposer = {
    prompt: "",
    attachmentCount: 0,
    terminalContextCount: 0,
    previewAnnotationCount: 0,
    reviewCommentCount: 0,
    threadReferenceCount: 0,
  };

  it("restores into a completely empty composer", () => {
    expect(shouldRestoreSubmittedDraft(emptyComposer)).toBe(true);
  });

  it("never overwrites any composer content the human added meanwhile", () => {
    const occupied = [
      { prompt: "typed something" },
      { attachmentCount: 1 },
      { terminalContextCount: 1 },
      { previewAnnotationCount: 1 },
      { reviewCommentCount: 1 },
      { threadReferenceCount: 1 },
    ];
    for (const overlay of occupied) {
      expect(shouldRestoreSubmittedDraft({ ...emptyComposer, ...overlay })).toBe(false);
    }
  });
});

describe("draft command intercepts: no non-success exit loses the draft", () => {
  // Companion to the no-fall-through invariant above: a recognised /handoff or
  // /retro that does not reach a successful dispatch must leave the typed text
  // recoverable in the composer.
  const runIntercept = async (options: {
    prompt: string;
    hasAttachmentsOrContexts: boolean;
    fail: boolean;
  }) => {
    const state = { prompt: options.prompt, sendInFlight: false };
    const handoff = decideHandoffSend({
      trimmedPrompt: state.prompt.trim(),
      hasAttachmentsOrContexts: options.hasAttachmentsOrContexts,
    });
    const retro = decideRetroSend({
      trimmedPrompt: state.prompt.trim(),
      hasAttachmentsOrContexts: options.hasAttachmentsOrContexts,
    });
    const decision = handoff.kind !== "not-handoff" ? handoff : retro;
    expect(decision.kind).not.toBe("not-handoff");
    expect(decision.kind).not.toBe("not-retro");
    if (decision.kind !== "dispatch") {
      // Inline-error branches return without touching the composer.
      return { outcome: decision.kind, prompt: state.prompt };
    }
    const outcome = await runComposerDraftIntercept({
      submittedPrompt: state.prompt,
      setSendInFlight: (inFlight) => {
        state.sendInFlight = inFlight;
      },
      clearComposer: () => {
        state.prompt = "";
      },
      readComposerContent: () => ({
        prompt: state.prompt,
        attachmentCount: 0,
        terminalContextCount: 0,
        previewAnnotationCount: 0,
        reviewCommentCount: 0,
        threadReferenceCount: 0,
      }),
      restoreComposer: (prompt) => {
        state.prompt = prompt;
      },
      dispatch: () =>
        Promise.resolve(
          options.fail
            ? AsyncResult.failure<{ ok: true }, string>(Cause.fail("nope"))
            : AsyncResult.success({ ok: true } as const),
        ),
      onSuccess: () => {},
      onFailure: () => {},
    });
    return { outcome, prompt: state.prompt };
  };

  it("preserves the draft on every non-success exit, for /handoff and /retro alike", async () => {
    const nonSuccessCases = [
      { prompt: "/handoff", hasAttachmentsOrContexts: false, fail: false },
      { prompt: "/handoff extract the retry logic", hasAttachmentsOrContexts: true, fail: false },
      { prompt: "/handoff extract the retry logic", hasAttachmentsOrContexts: false, fail: true },
      { prompt: "/retro gate outcomes", hasAttachmentsOrContexts: true, fail: false },
      { prompt: "/retro gate outcomes", hasAttachmentsOrContexts: false, fail: true },
    ];

    for (const testCase of nonSuccessCases) {
      const result = await runIntercept(testCase);
      expect(result.outcome).not.toBe("success");
      expect(result.prompt).toBe(testCase.prompt);
    }
  });

  it("clears the draft only on a successful dispatch", async () => {
    for (const prompt of ["/handoff extract the retry logic", "/retro gate outcomes"]) {
      const result = await runIntercept({ prompt, hasAttachmentsOrContexts: false, fail: false });
      expect(result.outcome).toBe("success");
      expect(result.prompt).toBe("");
    }
  });

  // The case the two accepted decisions only cover TOGETHER, and the one a
  // reviewer flagged as losing the draft when the receipt is absent: a failure
  // arriving after the human has typed something new. The no-clobber rule
  // deliberately declines to restore (their content wins), so the ONLY thing
  // keeping the submitted text on screen is the receipt. If a future change
  // drops the receipt, or stops recording it before the dispatch, this fails.
  it("keeps the submitted text recoverable via the receipt when the composer is not restored", async () => {
    const submittedPrompt = "/handoff the audit trail misses soft-deleted rows";
    const typedMeanwhile = "a totally unrelated new thought";
    const state = { prompt: submittedPrompt, sendInFlight: false };
    // Stands in for the receipt store: recorded BEFORE the RPC, holding the
    // explanation verbatim, exactly as ChatView.onSend wires it.
    const receipts: Array<{ explanation: string; failure: string | null }> = [];

    const decision = decideHandoffSend({
      trimmedPrompt: state.prompt.trim(),
      hasAttachmentsOrContexts: false,
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") return;
    const receipt = { explanation: decision.explanation, failure: null as string | null };
    receipts.push(receipt);

    const outcome = await runComposerDraftIntercept({
      submittedPrompt,
      setSendInFlight: (inFlight) => {
        state.sendInFlight = inFlight;
      },
      clearComposer: () => {
        state.prompt = "";
        // The human starts a new thought while the RPC is still in flight.
        state.prompt = typedMeanwhile;
      },
      readComposerContent: () => ({
        prompt: state.prompt,
        attachmentCount: 0,
        terminalContextCount: 0,
        previewAnnotationCount: 0,
        reviewCommentCount: 0,
        threadReferenceCount: 0,
      }),
      restoreComposer: (prompt) => {
        state.prompt = prompt;
      },
      dispatch: () =>
        Promise.resolve(AsyncResult.failure<{ ok: true }, string>(Cause.fail("rejected"))),
      onSuccess: () => {},
      onFailure: () => {
        receipt.failure = "Source thread is busy.";
      },
    });

    expect(outcome).toBe("failure");
    // Their new content is untouched — never clobbered.
    expect(state.prompt).toBe(typedMeanwhile);
    // ...and the submitted text is still on screen, in full, via the receipt.
    expect(receipts).toEqual([
      {
        explanation: "the audit trail misses soft-deleted rows",
        failure: "Source thread is busy.",
      },
    ]);
  });
});
