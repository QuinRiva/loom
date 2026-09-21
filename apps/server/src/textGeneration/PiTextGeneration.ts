/**
 * PiTextGeneration – text generation through the `pi` CLI.
 *
 * loom-only file: pi is the fork's single driver, so upstream's title, commit
 * message, change-request and branch-name flows all land here. Each operation
 * builds the shared prompt and runs it through one non-interactive
 * `pi --print --mode json` completion, the same way the Claude and Codex arms
 * run theirs through their own CLI. Failures surface as `TextGenerationError`
 * so upstream's callers can retry and fall back — nothing here invents a
 * deterministic placeholder.
 *
 * @module PiTextGeneration
 */
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type { ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { generatePiStructured } from "../provider/Layers/Pi/OneShotCompletion.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  type TextGenerationOperation,
} from "./TextGenerationUtils.ts";

export interface PiTextGenerationRuntime {
  /** `pi` settings binary path; the bundled CLI is resolved from it. */
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Working directory for operations that do not carry one of their own. */
  readonly cwd: string;
}

export function makePiTextGeneration(
  runtime: PiTextGenerationRuntime,
): TextGeneration.TextGeneration["Service"] {
  const run = <S extends Schema.Top>(input: {
    readonly operation: TextGenerationOperation;
    readonly cwd?: string | undefined;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }) => generatePiStructured({ ...runtime, ...input, cwd: input.cwd ?? runtime.cwd });

  return {
    generateCommitMessage: Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const generated = yield* run({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        }),
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    }),

    generatePrContent: Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* run({
        operation: "generatePrContent",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        }),
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),

    generateBranchName: Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* run({
        operation: "generateBranchName",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildBranchNamePrompt({ message: input.message, attachments: input.attachments }),
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),

    generateThreadTitle: Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* run({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          linkedContext: input.linkedContext,
          attachments: input.attachments,
        }),
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    }),

    // loom: generic structured generation — the fork's first-turn goal step.
    generateStructured: (input) => run({ operation: "generateStructured", ...input }),
  };
}
