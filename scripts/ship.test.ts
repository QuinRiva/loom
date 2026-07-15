import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { assertShippableBranch, planShipSteps, type ShipStep } from "./ship.ts";

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
  const steps = planShipSteps({ branch: "feature", message: "msg", mergeOnly: false });
  assert.deepEqual(stepKinds(steps), [
    "set-default",
    "commit",
    "fetch",
    "rebase",
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
  const steps = planShipSteps({ branch: "feature", message: "msg", mergeOnly: true });
  assert.notInclude(stepKinds(steps), "fetch");
  assert.notInclude(stepKinds(steps), "rebase");
  // Everything else still runs.
  assert.include(stepKinds(steps), "check");
  assert.include(stepKinds(steps), "delete-branch");
});

it("deletes the remote branch explicitly and never uses --delete-branch", () => {
  const steps = planShipSteps({ branch: "feature", message: "msg", mergeOnly: false });
  const deleteStep = steps.find((step) => step.kind === "delete-branch");
  assert.deepEqual(deleteStep?.args, ["push", "origin", "--delete", "feature"]);
  for (const step of steps) {
    assert.notInclude(step.args, "--delete-branch");
  }
});

it("never pushes to main directly", () => {
  const steps = planShipSteps({ branch: "feature", message: "msg", mergeOnly: false });
  const pushSteps = steps.filter((step) => step.executable === "git" && step.args[0] === "push");
  for (const step of pushSteps) {
    assert.notInclude(step.args, "main");
  }
});

it("fills the PR from the commit by default and honours explicit title/body", () => {
  const filled = planShipSteps({ branch: "feature", message: "msg", mergeOnly: false }).find(
    (step) => step.kind === "pr-create",
  );
  assert.include(filled?.args ?? [], "--fill");

  const framed = planShipSteps({
    branch: "feature",
    message: "msg",
    mergeOnly: false,
    title: "Nice title",
    body: "Explains the change",
  }).find((step) => step.kind === "pr-create");
  assert.notInclude(framed?.args ?? [], "--fill");
  assert.include(framed?.args ?? [], "--title");
  assert.include(framed?.args ?? [], "Nice title");
  assert.include(framed?.args ?? [], "--body");
  assert.include(framed?.args ?? [], "Explains the change");
});
