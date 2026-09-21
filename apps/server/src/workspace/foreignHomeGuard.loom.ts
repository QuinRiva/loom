// @effect-diagnostics nodeBuiltinImport:off
// loom: refuse side effects that would land on another home's checkouts.
//
// The DB-copy smoke recipe (docs/dev-site-testing.md) boots a real server on a
// `VACUUM INTO` copy of the cockpit database under a throwaway `--home-dir`.
// The copy carries the ORIGINAL home's recorded worktree paths, branches and
// provider sessions, so every path-keyed side effect — the worktree reaper, the
// fan-in reactor, storage cleanup, checkpoint capture, setup scripts, provider
// launches — aims at the live checkouts of whoever owns them. It has happened
// twice; both times only git's refusal to delete a checked-out branch saved the
// sibling worktrees.
//
// The discriminator is PROVENANCE, not path shape: a home's recorded worktree
// paths always sit under its own `worktreesDir`, because that is where the
// provisioner puts them. A database that records worktree paths and has none of
// them inside the running server's `worktreesDir` therefore did not come from
// this home, and the server drops into a read-only posture: every mutating
// facade refuses with one warning instead of acting on a stranger's disk.
//
// Boot-scoped process-global, decided once in `serverRuntimeStartup` before any
// reactor starts. Same shape (and same justification) as the reaper's
// env-scoped reclaim switch: threading a service through the git driver core,
// the checkpoint store, the provider service and the setup-script runner would
// cost far more plumbing than one boot-time fact is worth.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

/** The one refusal sentence every guarded call site reports. */
export const FOREIGN_HOME_REFUSAL_DETAIL =
  "refused: this server's home does not own that checkout (foreign-home guard)";

/** Set once at boot; `null` means "this database belongs to this home". */
let foreignHome: {
  readonly worktreesDir: string;
  readonly recordedExample: string;
  readonly recordedCount: number;
} | null = null;

/** One warning per (site, target); a refused sweep re-runs on every tick. */
const warned = new Set<string>();

/** `target` is `dir` itself or below it. Both sides are resolved first. */
export const isInsideDirectory = (dir: string, target: string): boolean => {
  const root = NodePath.resolve(dir);
  const resolved = NodePath.resolve(target);
  return resolved === root || resolved.startsWith(root + NodePath.sep);
};

/**
 * Decide, from the paths the database records, whether it came from this home.
 * A database with no recorded worktree path at all says nothing either way and
 * is treated as ours — it has no foreign checkout to damage.
 */
export const detectForeignDatabase = (input: {
  readonly worktreesDir: string;
  readonly recordedWorktreePaths: Iterable<string>;
}) =>
  Effect.gen(function* () {
    const recorded = [...input.recordedWorktreePaths];
    const ours = recorded.some((path) => isInsideDirectory(input.worktreesDir, path));
    foreignHome =
      recorded.length === 0 || ours
        ? null
        : {
            worktreesDir: NodePath.resolve(input.worktreesDir),
            recordedExample: recorded[0]!,
            recordedCount: recorded.length,
          };
    warned.clear();
    if (foreignHome === null) return;
    yield* Effect.logWarning(
      "foreign-home guard: this database was copied from another T3 home; mutating side effects are refused",
      {
        worktreesDir: foreignHome.worktreesDir,
        recordedExample: foreignHome.recordedExample,
        recordedWorktreePaths: foreignHome.recordedCount,
      },
    );
  });

export const isForeignDatabase = (): boolean => foreignHome !== null;

/**
 * Gate for one mutating call site. Returns `true` when the caller must NOT act
 * — the caller decides whether that is a silent skip or a typed failure.
 */
export const refuseForeignHomeSideEffect = (site: string, target: string) =>
  Effect.gen(function* () {
    if (foreignHome === null) return false;
    const key = `${site}\u0000${target}`;
    if (!warned.has(key)) {
      warned.add(key);
      yield* Effect.logWarning("foreign-home guard refused a side effect", {
        site,
        target,
        worktreesDir: foreignHome.worktreesDir,
        recordedExample: foreignHome.recordedExample,
      });
    }
    return true;
  });

/** Test seam: drive the boot-time decision directly. */
export const setForeignDatabaseForTest = (
  state: { readonly worktreesDir: string; readonly recordedExample: string } | null,
): void => {
  foreignHome =
    state === null
      ? null
      : {
          worktreesDir: NodePath.resolve(state.worktreesDir),
          recordedExample: state.recordedExample,
          recordedCount: 1,
        };
  warned.clear();
};
