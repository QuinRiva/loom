import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { assertShippableBranch, assertSummaryKind, planShipSteps, type ShipStep } from "./ship.ts";

const note = { message: "msg", summary: 'Fixes "#12": tables scroll', kind: "noticeable" } as const;

function stepKinds(steps: ReadonlyArray<ShipStep>): ReadonlyArray<string> {
  return steps.map((step) => step.kind);
}

it.effect("refuses to ship from protected branches", () =>
  Effect.gen(function* () {
    for (const branch of ["main", "master", "HEAD"]) {
      const error = yield* assertShippableBranch(branch).pipe(Effect.flip);
      assert.equal(error._tag, "ShipProtectedBranchError");
      assert.equal(error.branch, branch);
    }
  }),
);

it.effect("passes through a feature branch", () =>
  Effect.gen(function* () {
    const branch = yield* assertShippableBranch("t3code/ship-skill");
    assert.equal(branch, "t3code/ship-skill");
  }),
);

it("orders the sequence set-default → commit → rebase → gate → push → PR → merge → confirm → delete", () => {
  const steps = planShipSteps({ branch: "feature", ...note, mergeOnly: false });
  assert.deepEqual(stepKinds(steps), [
    "set-default",
    "commit",
    "fetch",
    "rebase",
    // typecheck, vp check, and the unmarked-delta sweep.
    "check",
    "check",
    "check",
    "push",
    "pr-create",
    "pr-merge",
    "pr-confirm",
    "delete-branch",
  ]);
  // set-default must come first so gh targets origin, not the upstream parent.
  assert.equal(steps[0]?.kind, "set-default");
  assert.deepEqual(steps[0]?.args, ["repo", "set-default", "QuinRiva/loom"]);
});

it("skips the rebase for an upstream-sync (merge-only) branch", () => {
  const steps = planShipSteps({ branch: "feature", ...note, mergeOnly: true });
  assert.notInclude(stepKinds(steps), "fetch");
  assert.notInclude(stepKinds(steps), "rebase");
  // Everything else still runs.
  assert.include(stepKinds(steps), "check");
  assert.include(stepKinds(steps), "delete-branch");
});

it("stops at the open PR with --pr-only", () => {
  const steps = planShipSteps({
    branch: "feature",
    ...note,
    mergeOnly: false,
    prOnly: true,
  });
  assert.equal(steps.at(-1)?.kind, "pr-create");
  assert.notInclude(stepKinds(steps), "pr-merge");
  assert.notInclude(stepKinds(steps), "delete-branch");
  // The gate still runs before the push.
  assert.include(stepKinds(steps), "check");
  assert.include(stepKinds(steps), "push");
});

it("reuses an already-open PR instead of creating one", () => {
  const options = { branch: "feature", message: "msg", mergeOnly: false, prOpen: true };
  const steps = planShipSteps(options);
  assert.notInclude(stepKinds(steps), "pr-create");
  assert.include(stepKinds(steps), "pr-merge");
  assert.equal(planShipSteps({ ...options, prOnly: true }).at(-1)?.kind, "push");
});

it("deletes the remote branch explicitly and never uses --delete-branch", () => {
  const steps = planShipSteps({ branch: "feature", ...note, mergeOnly: false });
  const deleteStep = steps.find((step) => step.kind === "delete-branch");
  assert.deepEqual(deleteStep?.args, ["push", "origin", "--delete", "feature"]);
  for (const step of steps) {
    assert.notInclude(step.args, "--delete-branch");
  }
});

it("never pushes to main directly", () => {
  const steps = planShipSteps({ branch: "feature", ...note, mergeOnly: false });
  const pushSteps = steps.filter((step) => step.executable === "git" && step.args[0] === "push");
  for (const step of pushSteps) {
    assert.notInclude(step.args, "main");
  }
});

it.effect("refuses a missing, multi-line or empty summary and an unknown kind", () =>
  Effect.gen(function* () {
    const problems = (summary: string | undefined, kind: string | undefined) =>
      assertSummaryKind(summary, kind).pipe(
        Effect.flip,
        Effect.map((error) => error.problems),
      );
    // Both missing is the plain refusal; its message carries the guidance.
    assert.deepEqual(yield* problems(undefined, undefined), []);
    assert.deepEqual(yield* problems("ok", undefined), ["--kind is missing."]);
    assert.deepEqual(yield* problems("one\ntwo", "behind"), ["--summary spans several lines."]);
    assert.deepEqual(yield* problems(" ", "loud"), [
      "--summary is empty.",
      '--kind "loud" is neither noticeable nor behind.',
    ]);
    const ok = yield* assertSummaryKind(" Tables scroll ", "behind");
    assert.deepEqual(ok, { summary: "Tables scroll", kind: "behind" });
  }),
);

it("titles the PR from -m unless --title is given, and ends both bodies with the trailers", () => {
  const trailers = 'Loom-Summary: Fixes "#12": tables scroll\nLoom-Kind: noticeable';
  const args = (options: { title?: string; body?: string }) => {
    const steps = planShipSteps({ branch: "feature", ...note, mergeOnly: false, ...options });
    return ["pr-create", "pr-merge"].map((kind) => steps.find((step) => step.kind === kind)?.args);
  };

  assert.deepEqual(args({}), [
    ["pr", "create", "--base", "main", "--title", "msg", "--body", trailers],
    ["pr", "merge", "--merge", "--body", `msg\n\n${trailers}`],
  ]);
  // The merge body's first line is the PR title, as in GitHub's default merge message.
  assert.deepEqual(args({ title: "Nice title", body: "Explains the change\n" }), [
    [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "Nice title",
      "--body",
      `Explains the change\n\n${trailers}`,
    ],
    ["pr", "merge", "--merge", "--body", `Nice title\n\n${trailers}`],
  ]);
});
