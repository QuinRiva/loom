#!/usr/bin/env node

// Mechanical ship sequence: rebase onto origin/main, gate on checks, push, open the PR,
// merge, and delete the remote branch. The judgment parts (when to ship, PR framing,
// upstream-sync detection, real conflicts) live in docs/operations/shipping.md; this
// script encodes the steps and the footgun guards.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// The PR target for this fork. This clone has an `upstream` remote
// (pingdotgg/t3code); without pinning the default, `gh` resolves the PR base to
// the fork parent and fails with "No commits between…".
const SHIP_REPO = "QuinRiva/loom";
const PROTECTED_BRANCHES = ["main", "master", "HEAD"] as const;

export type ShipStepKind =
  | "set-default"
  | "commit"
  | "fetch"
  | "rebase"
  | "check"
  | "push"
  | "pr-create"
  | "pr-merge"
  | "pr-confirm"
  | "delete-branch";

export interface ShipStep {
  readonly kind: ShipStepKind;
  readonly title: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export interface ShipPlanOptions {
  readonly branch: string;
  readonly message: string;
  readonly mergeOnly: boolean;
  readonly prOnly?: boolean | undefined;
  readonly prOpen?: boolean | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
}

export class ShipProtectedBranchError extends Schema.TaggedError<ShipProtectedBranchError>()(
  "ShipProtectedBranchError",
  {
    branch: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to ship from "${this.branch}": ship from a feature branch, never directly on main.`;
  }
}

export class ShipUntrackedFilesError extends Schema.TaggedError<ShipUntrackedFilesError>()(
  "ShipUntrackedFilesError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      "Refusing to ship: the commit step would publish these untracked files:",
      ...this.paths.map((path) => `  ${path}`),
      "Commit the ones that belong to the change by path (git add <path> && git commit),",
      "re-run with --include-untracked if every listed file belongs to it,",
      "or move or delete the strays.",
    ].join("\n");
  }
}

export class ShipProcessError extends Schema.TaggedError<ShipProcessError>()("ShipProcessError", {
  operation: Schema.Literals(["spawn", "communicate"]),
  kind: Schema.String,
  executable: Schema.String,
  argumentCount: Schema.Number,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Ship step "${this.kind}" failed to ${this.operation} "${this.executable}".`;
  }
}

export class ShipStepExitError extends Schema.TaggedError<ShipStepExitError>()(
  "ShipStepExitError",
  {
    kind: Schema.String,
    executable: Schema.String,
    argumentCount: Schema.Number,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Ship step "${this.kind}" (${this.executable}) exited with code ${this.exitCode}.`;
  }
}

export class ShipRebaseConflictError extends Schema.TaggedError<ShipRebaseConflictError>()(
  "ShipRebaseConflictError",
  {
    conflictingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const files =
      this.conflictingFiles.length > 0 ? this.conflictingFiles.join(", ") : "(none reported)";
    return [
      "Rebase onto origin/main hit a real merge conflict; aborted without guessing.",
      `Conflicting files: ${files}.`,
      "Escalate to the orchestrator/human — resolving this needs goal context the ship",
      "script does not have. See docs/operations/shipping.md.",
    ].join(" ");
  }
}

export class ShipMergeNotConfirmedError extends Schema.TaggedError<ShipMergeNotConfirmedError>()(
  "ShipMergeNotConfirmedError",
  {
    state: Schema.String,
  },
) {
  override get message(): string {
    return `PR state is "${this.state}", not MERGED; leaving the remote branch in place.`;
  }
}

/**
 * Build the ordered mechanical ship sequence as data. Pure so the footgun guards
 * (never push main, never `--delete-branch`, always set-default, upstream-sync
 * branches skip the rebase) are unit-testable without touching git/gh.
 */
export function planShipSteps(options: ShipPlanOptions): ReadonlyArray<ShipStep> {
  const prArgs =
    options.title !== undefined || options.body !== undefined
      ? [
          "pr",
          "create",
          "--base",
          "main",
          // gh requires --title whenever --body is given; the commit message is the title's source.
          "--title",
          options.title ?? options.message,
          ...(options.body !== undefined ? ["--body", options.body] : []),
        ]
      : ["pr", "create", "--base", "main", "--fill"];

  const steps: ReadonlyArray<ShipStep> = [
    {
      kind: "set-default",
      title: `Pin PR target to ${SHIP_REPO} (not the upstream fork parent)`,
      executable: "gh",
      args: ["repo", "set-default", SHIP_REPO],
    },
    {
      kind: "commit",
      title: "Commit pending work",
      executable: "git",
      args: ["commit", "-m", options.message],
    },
    // Upstream-sync branches carry a `git merge upstream/main` commit and must be
    // merge-only — skip the rebase entirely when --merge-only is set.
    ...(options.mergeOnly
      ? []
      : ([
          {
            kind: "fetch",
            title: "Fetch current origin/main",
            executable: "git",
            args: ["fetch", "origin", "main"],
          },
          {
            kind: "rebase",
            title: "Rebase onto origin/main before pushing",
            executable: "git",
            args: ["rebase", "origin/main"],
          },
        ] satisfies ReadonlyArray<ShipStep>)),
    {
      kind: "check",
      title: "Gate: vp check",
      executable: "vp",
      args: ["check"],
    },
    {
      kind: "check",
      title: "Gate: vp run typecheck",
      executable: "vp",
      args: ["run", "typecheck"],
    },
    {
      // An unmarked loom hunk in an upstream-owned file is invisible to every
      // audit and is silently dropped at the next cadence pull. Scoped to what
      // this branch changes; the whole-fork backlog is `--report`, not a gate.
      kind: "check",
      title: "Gate: unmarked-delta sweep",
      executable: "docs/upstream-sync/pull7-tools/unmarkedsweep.sh",
      args: [],
    },
    {
      kind: "push",
      title: "Push branch and set upstream",
      executable: "git",
      // A re-ship of an already-pushed branch (an open PR) has just been rebased.
      args: ["push", "--force-with-lease", "-u", "origin", "HEAD"],
    },
    {
      kind: "pr-create",
      title: "Open the PR into main",
      executable: "gh",
      args: prArgs,
    },
    {
      kind: "pr-merge",
      title: "Merge the PR",
      executable: "gh",
      args: ["pr", "merge", "--merge"],
    },
    {
      kind: "pr-confirm",
      title: "Confirm the merged state",
      executable: "gh",
      args: ["pr", "view", "--json", "state"],
    },
    // Explicit remote-branch delete AFTER a confirmed merge. Never
    // `gh pr merge --delete-branch`: these are shared-clone worktrees with main
    // checked out elsewhere, so it fails mid-way and leaves the branch undeleted.
    {
      kind: "delete-branch",
      title: "Delete the remote branch",
      executable: "git",
      args: ["push", "origin", "--delete", options.branch],
    },
  ];
  // --pr-only is the `human` merge-authority ceiling: stop at the open PR.
  const planned = options.prOnly
    ? steps.slice(
        0,
        steps.findIndex((step) => step.kind === "pr-merge"),
      )
    : steps;
  // A branch whose PR is already open (e.g. from an earlier --pr-only) reuses it.
  return options.prOpen ? planned.filter((step) => step.kind !== "pr-create") : planned;
}

/**
 * Reject shipping from a protected branch. Pure so the guard is unit-testable.
 */
export function assertShippableBranch(
  branch: string,
): Effect.Effect<string, ShipProtectedBranchError> {
  return PROTECTED_BRANCHES.includes(branch as (typeof PROTECTED_BRANCHES)[number])
    ? Effect.fail(new ShipProtectedBranchError({ branch }))
    : Effect.succeed(branch);
}

const collectStream = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one command. `capture` pipes stdout/stderr back as strings (for the steps
 * whose output the script inspects); otherwise stdio is inherited so the
 * operator sees git/gh/vp output live.
 */
const runProcess = Effect.fn("runProcess")(function* (
  kind: ShipStepKind | "inspect",
  executable: string,
  args: ReadonlyArray<string>,
  capture: boolean,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = capture
    ? ChildProcess.make(executable, args)
    : ChildProcess.make(executable, args, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
  const errorContext = { kind, executable, argumentCount: args.length } as const;
  const child = yield* spawner
    .spawn(command)
    .pipe(
      Effect.mapError(
        (cause) => new ShipProcessError({ ...errorContext, operation: "spawn", cause }),
      ),
    );

  if (!capture) {
    const exitCode = yield* child.exitCode.pipe(
      Effect.map(Number),
      Effect.mapError(
        (cause) => new ShipProcessError({ ...errorContext, operation: "communicate", cause }),
      ),
    );
    return { exitCode, stdout: "", stderr: "" } satisfies RunResult;
  }

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStream(child.stdout),
      collectStream(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) => new ShipProcessError({ ...errorContext, operation: "communicate", cause }),
    ),
  );
  return { exitCode, stdout, stderr } satisfies RunResult;
});

const runInherited = Effect.fn("runInherited")(function* (step: ShipStep) {
  yield* Console.log(`\n▸ ${step.title}\n  ${step.executable} ${step.args.join(" ")}`);
  const result = yield* runProcess(step.kind, step.executable, step.args, false).pipe(
    Effect.scoped,
  );
  if (result.exitCode !== 0) {
    return yield* new ShipStepExitError({
      kind: step.kind,
      executable: step.executable,
      argumentCount: step.args.length,
      exitCode: result.exitCode,
    });
  }
});

const captureGit = Effect.fn("captureGit")(function* (args: ReadonlyArray<string>) {
  return yield* runProcess("inspect", "git", args, true).pipe(Effect.scoped);
});

const getCurrentBranch = Effect.fn("getCurrentBranch")(function* () {
  const result = yield* captureGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.stdout.trim();
});

const treeIsDirty = Effect.fn("treeIsDirty")(function* () {
  const result = yield* captureGit(["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
});

const decodeOpenPrs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ number: Schema.Number, url: Schema.String }))),
);

const findOpenPr = Effect.fn("findOpenPr")(function* (branch: string) {
  const args = [
    "pr",
    "list",
    "--repo",
    SHIP_REPO,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,url",
  ];
  const result = yield* runProcess("inspect", "gh", args, true).pipe(Effect.scoped);
  if (result.exitCode !== 0) {
    return yield* new ShipStepExitError({
      kind: "inspect",
      executable: "gh",
      argumentCount: args.length,
      exitCode: result.exitCode,
    });
  }
  const prs = yield* decodeOpenPrs(result.stdout);
  return Option.fromNullishOr(prs[0]);
});

const runCommitStep = Effect.fn("runCommitStep")(function* (step: ShipStep) {
  if (!(yield* treeIsDirty())) {
    yield* Console.log("\n▸ Commit pending work\n  (working tree clean — nothing to commit)");
    return;
  }
  yield* runInherited({
    kind: "commit",
    title: "Stage all changes",
    executable: "git",
    args: ["add", "-A"],
  });
  yield* runInherited(step);
});

const runRebaseStep = Effect.fn("runRebaseStep")(function* (step: ShipStep) {
  yield* Console.log(`\n▸ ${step.title}\n  ${step.executable} ${step.args.join(" ")}`);
  const result = yield* runProcess(step.kind, step.executable, step.args, false).pipe(
    Effect.scoped,
  );
  if (result.exitCode === 0) {
    return;
  }
  // Anything beyond a trivially clean rebase: do not guess. Record the
  // conflicting files, abort, and escalate.
  const conflicted = yield* captureGit(["diff", "--name-only", "--diff-filter=U"]);
  const conflictingFiles = conflicted.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  yield* runInherited({
    kind: "rebase",
    title: "Abort the conflicted rebase",
    executable: "git",
    args: ["rebase", "--abort"],
  });
  return yield* new ShipRebaseConflictError({ conflictingFiles });
});

const runConfirmStep = Effect.fn("runConfirmStep")(function* (step: ShipStep) {
  yield* Console.log(`\n▸ ${step.title}\n  ${step.executable} ${step.args.join(" ")}`);
  const result = yield* runProcess(step.kind, step.executable, step.args, true).pipe(Effect.scoped);
  if (result.exitCode !== 0) {
    return yield* new ShipStepExitError({
      kind: step.kind,
      executable: step.executable,
      argumentCount: step.args.length,
      exitCode: result.exitCode,
    });
  }
  // `gh pr merge` is silent on success in a piped shell, so confirm explicitly.
  const state = ((): string => {
    try {
      const parsed = JSON.parse(result.stdout) as { readonly state?: unknown };
      return typeof parsed.state === "string" ? parsed.state : "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  })();
  yield* Console.log(`  state=${state}`);
  if (state !== "MERGED") {
    return yield* new ShipMergeNotConfirmedError({ state });
  }
});

const runShipStep = Effect.fn("runShipStep")(function* (step: ShipStep) {
  switch (step.kind) {
    case "commit":
      return yield* runCommitStep(step);
    case "rebase":
      return yield* runRebaseStep(step);
    case "pr-confirm":
      return yield* runConfirmStep(step);
    default:
      return yield* runInherited(step);
  }
});

export const runShip = Effect.fn("runShip")(function* (options: {
  readonly message: string;
  readonly mergeOnly: boolean;
  readonly prOnly: boolean;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly dryRun: boolean;
  readonly includeUntracked: boolean;
}) {
  const branch = yield* assertShippableBranch(yield* getCurrentBranch());
  const untracked = yield* captureGit(["ls-files", "-z", "--others", "--exclude-standard"]);
  const paths = untracked.stdout.split("\0").filter((path) => path.length > 0);
  if (paths.length > 0 && !options.includeUntracked) {
    return yield* new ShipUntrackedFilesError({ paths });
  }
  const openPr = yield* findOpenPr(branch);
  const steps = planShipSteps({
    branch,
    message: options.message,
    mergeOnly: options.mergeOnly,
    prOnly: options.prOnly,
    prOpen: Option.isSome(openPr),
    title: options.title,
    body: options.body,
  });

  if (Option.isSome(openPr)) {
    yield* Console.log(
      `Reusing open PR #${openPr.value.number} (${openPr.value.url}); not creating one.`,
    );
  }
  if (options.dryRun) {
    yield* Console.log(`Ship plan for "${branch}"${options.mergeOnly ? " (merge-only)" : ""}:`);
    for (const step of steps) {
      yield* Console.log(`  • ${step.title}\n      ${step.executable} ${step.args.join(" ")}`);
    }
    return;
  }

  yield* Console.log(
    `Shipping "${branch}"${options.mergeOnly ? " (merge-only)" : ""} → ${SHIP_REPO}`,
  );
  for (const step of steps) {
    yield* runShipStep(step);
  }
  yield* Console.log(
    options.prOnly
      ? `\n✓ The PR for "${branch}" is open; not merged (--pr-only).`
      : `\n✓ Shipped "${branch}" and deleted the remote branch.`,
  );
});

export const shipCommand = Command.make(
  "ship",
  {
    message: Flag.String("message").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Commit message / PR title source for the work being shipped."),
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription("Explicit PR title (otherwise the PR is filled from the commit)."),
      Flag.optional,
    ),
    body: Flag.String("body").pipe(
      Flag.withDescription("Explicit PR body (otherwise the PR is filled from the commit)."),
      Flag.optional,
    ),
    mergeOnly: Flag.Boolean("merge-only").pipe(
      Flag.withDescription(
        "Skip the rebase for an upstream-sync branch (a branch carrying a merge upstream/main commit must be merge-only).",
      ),
      Flag.withDefault(false),
    ),
    prOnly: Flag.Boolean("pr-only").pipe(
      Flag.withDescription(
        "Stop once the PR is open: no merge, no branch delete (the ceiling under human merge authority, or when the human will merge or close the PR).",
      ),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the ordered ship sequence without running git/gh/vp."),
      Flag.withDefault(false),
    ),
    includeUntracked: Flag.Boolean("include-untracked").pipe(
      Flag.withDescription(
        "Commit untracked files too; without it the ship refuses when any exist (gitignored paths are not counted).",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ message, title, body, mergeOnly, prOnly, dryRun, includeUntracked }) =>
    runShip({
      message,
      mergeOnly,
      prOnly,
      dryRun,
      includeUntracked,
      title: Option.getOrUndefined(title),
      body: Option.getOrUndefined(body),
    }),
).pipe(
  Command.withDescription(
    "Land approved work on main (rebase → gate → push → PR → merge → delete). See docs/operations/shipping.md.",
  ),
);

if (import.meta.main) {
  Command.run(shipCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
