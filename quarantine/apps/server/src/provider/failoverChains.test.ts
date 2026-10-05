import { describe, expect, it } from "@effect/vitest";

import { resolveFailoverTarget } from "./failoverChains.ts";

// Live catalogue slugs the resolver may pick from.
const CATALOGUE = new Set([
  "openai-codex/gpt-5.5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-fable-5",
  "google-vertex-claude/claude-opus-4-8",
  "google-vertex-claude/claude-fable-5",
]);

/** Build an `isExhausted` predicate from a list of exhausted (accountKey, modelScope) marks. */
const exhausted = (marks: ReadonlyArray<readonly [string, string]>) => {
  return (accountKey: string, modelId?: string): boolean =>
    marks.some(([key, scope]) => key === accountKey && (scope === "*" || scope === modelId));
};

describe("resolveFailoverTarget", () => {
  it("routes exhausted Codex to Opus on the Anthropic subscription first", () => {
    const target = resolveFailoverTarget({
      slug: "openai-codex/gpt-5.5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([["codex", "*"]]),
    });
    expect(target).toBe("anthropic/claude-opus-4-8");
  });

  it("falls through Codex chain to Vertex Opus when Anthropic is also exhausted", () => {
    const target = resolveFailoverTarget({
      slug: "openai-codex/gpt-5.5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([
        ["codex", "*"],
        ["claudeAgent", "*"],
      ]),
    });
    expect(target).toBe("google-vertex-claude/claude-opus-4-8");
  });

  it("model-scoped Anthropic exhaustion routes to the same model on Vertex (D2)", () => {
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([["claudeAgent", "claude-fable-5"]]),
    });
    expect(target).toBe("google-vertex-claude/claude-fable-5");
  });

  it("model-scoped Anthropic falls to Opus-on-subscription when Vertex twin is absent", () => {
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: new Set([...CATALOGUE].filter((s) => s !== "google-vertex-claude/claude-fable-5")),
      isExhausted: exhausted([["claudeAgent", "claude-fable-5"]]),
    });
    expect(target).toBe("anthropic/claude-opus-4-8");
  });

  it("account-wide Anthropic exhaustion only offers the same model on Vertex", () => {
    // Opus-on-Anthropic must be skipped: the whole subscription is dead.
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([["claudeAgent", "*"]]),
    });
    expect(target).toBe("google-vertex-claude/claude-fable-5");
  });

  it("returns undefined when the account-wide chain's only target is gone", () => {
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: new Set([...CATALOGUE].filter((s) => s !== "google-vertex-claude/claude-fable-5")),
      isExhausted: exhausted([["claudeAgent", "*"]]),
    });
    expect(target).toBeUndefined();
  });

  it("mirrors Vertex back to the same model on Anthropic", () => {
    const target = resolveFailoverTarget({
      slug: "google-vertex-claude/claude-opus-4-8",
      catalogue: CATALOGUE,
      // Vertex is API-billed (no account key) — pretend it is exhausted anyway.
      isExhausted: exhausted([]),
    });
    expect(target).toBe("anthropic/claude-opus-4-8");
  });

  it("skips the intended slug itself when it appears in a chain", () => {
    // Model-scoped Opus-on-Anthropic: chain is [vertex-opus, anthropic-opus];
    // the second entry equals the exhausted slug and must be skipped.
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-opus-4-8",
      catalogue: new Set(["anthropic/claude-opus-4-8"]),
      isExhausted: exhausted([["claudeAgent", "claude-opus-4-8"]]),
    });
    expect(target).toBeUndefined();
  });

  it("honours an exact-slug user override before the namespace wildcard", () => {
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([["claudeAgent", "claude-fable-5"]]),
      chains: {
        "anthropic/claude-fable-5": ["anthropic/claude-opus-4-8"],
        "anthropic/*": ["google-vertex-claude/claude-fable-5"],
      },
    });
    expect(target).toBe("anthropic/claude-opus-4-8");
  });

  it("applies a namespace-wildcard override with <m> substitution", () => {
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([["claudeAgent", "claude-fable-5"]]),
      chains: { "anthropic/*": ["google-vertex-claude/*"] },
    });
    expect(target).toBe("google-vertex-claude/claude-fable-5");
  });

  it("skips override targets that are themselves exhausted", () => {
    const target = resolveFailoverTarget({
      slug: "anthropic/claude-fable-5",
      catalogue: CATALOGUE,
      isExhausted: exhausted([
        ["claudeAgent", "claude-fable-5"],
        ["codex", "*"],
      ]),
      chains: { "anthropic/*": ["openai-codex/gpt-5.5", "google-vertex-claude/claude-fable-5"] },
    });
    expect(target).toBe("google-vertex-claude/claude-fable-5");
  });
});
