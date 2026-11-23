import { splitFilePathPosition } from "@t3tools/shared/fileLinks";

/**
 * Unanchored file references (a bare `prices.json`, `results/x.md`) are relative to wherever the
 * agent last `cd`'d, so the root's miss is not evidence the file is gone. Web and mobile resolve
 * them in one order: the root, each directory the message names, then the path index's unique
 * match. Anchored ones (absolute, `~/`, `./`, `../`, URLs) name one place and are not looked up.
 */
export function isAnchoredFileReference(text: string): boolean {
  const normalized = text.trim().replaceAll("\\", "/");
  return /^(?:\/|[A-Za-z]:\/|~\/|\.{1,2}\/|[A-Za-z][\w+.-]*:\/\/)/.test(normalized);
}

/** Only regular files and directories exist; anything else (FIFOs, unreadable) does not. */
export interface PathExistence {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

/**
 * The paths a message names that could be directories, in order: one written with a trailing
 * separator, or one whose last segment has no extension. A guess under one counts only once its
 * stat says directory (`candidateExistence`), so an extensionless file like `Makefile` costs no
 * child stats and a named file is never searched.
 */
export function directoryBasesFromPaths(filePaths: Iterable<string>): string[] {
  return [
    ...new Set(
      [...filePaths].flatMap((filePath) =>
        /[\\/]$/.test(filePath) || !/[^\\/.]\.[^\\/.]+$/.test(filePath)
          ? [filePath.replace(/[\\/]+$/, "")].filter(Boolean)
          : [],
      ),
    ),
  ];
}

/** The span's path without its `:line[:col]` suffix: what the index matches. */
export function unanchoredLocateReference(span: string): string {
  return splitFilePathPosition(span.trim().replaceAll("\\", "/")).path;
}

/** A stat candidate; `base` is the named path it sits under, null for the root resolution. */
export interface UnanchoredCandidate {
  readonly path: string;
  readonly base: string | null;
}

/** Stat candidates in priority order: the root resolution, then the span under each named path. */
export function unanchoredCandidatePaths(
  rootPath: string,
  reference: string,
  directoryBases: readonly string[],
): UnanchoredCandidate[] {
  const candidates = [
    { path: rootPath, base: null },
    ...directoryBases.map((base) => ({ path: `${base}/${reference}`, base })),
  ];
  return candidates.filter(
    ({ path }, index) => candidates.findIndex((c) => c.path === path) === index,
  );
}

const ABSENT: PathExistence = { exists: false, isDirectory: false };

/**
 * A candidate under a named path is unverified until that path's stat answers, and absent unless
 * it is a directory: its own stat is only needed (or issued) once the base is one.
 */
function candidateExistence(
  candidate: UnanchoredCandidate,
  lookupExistence: (path: string) => PathExistence | undefined,
): PathExistence | undefined {
  if (candidate.base === null) return lookupExistence(candidate.path);
  const base = lookupExistence(candidate.base);
  return base?.isDirectory ? lookupExistence(candidate.path) : base && ABSENT;
}

/**
 * The bound path, or null. Candidates bind in order to the first confirmed regular file, and an
 * unverified one blocks the rest so the choice never flips upward; past them the index's unique
 * match binds unless a stat found it gone. `located` is undefined while the index is unanswered,
 * null when it matched none or several, so an ambiguous reference never binds.
 */
export function selectUnanchoredPath(input: {
  readonly candidates: readonly UnanchoredCandidate[];
  readonly lookupExistence: (path: string) => PathExistence | undefined;
  readonly located: string | null | undefined;
}): string | null {
  for (const candidate of input.candidates) {
    const existence = candidateExistence(candidate, input.lookupExistence);
    if (existence === undefined) return null;
    if (existence.exists && !existence.isDirectory) return candidate.path;
  }
  if (!input.located || input.lookupExistence(input.located)?.exists === false) return null;
  return input.located;
}

export type UnanchoredLookupResult =
  | { readonly _tag: "Found"; readonly path: string }
  | { readonly _tag: "NotFound" }
  /** A stat or the index could not answer, so the miss proves nothing. */
  | { readonly _tag: "Unverified" };

/**
 * {@link selectUnanchoredPath} run once, for a tap. Every candidate stat and the index lookup go
 * out together, but the answer comes as soon as it is settled: a confirmed candidate opens without
 * waiting on the index, which may still be scanning. The index's match is stat'd so a file deleted
 * since it was indexed is not opened. `stat` and `locate` resolve undefined when they could not answer.
 */
export async function lookUpUnanchoredFile(input: {
  readonly candidates: readonly UnanchoredCandidate[];
  readonly reference: string;
  readonly stat: (path: string) => Promise<PathExistence | undefined>;
  readonly locate: (reference: string) => Promise<string | null | undefined>;
}): Promise<UnanchoredLookupResult> {
  const settle = <A>(promise: Promise<A>) => promise.catch(() => undefined);
  const paths = input.candidates.flatMap(({ path, base }) =>
    base === null ? [path] : [base, path],
  );
  const stats = new Map([...new Set(paths)].map((path) => [path, settle(input.stat(path))]));
  const locating = settle(input.locate(input.reference));
  const existence = new Map<string, PathExistence | undefined>();
  const lookupExistence = (path: string) => existence.get(path);
  for (const candidate of input.candidates) {
    if (candidate.base !== null) existence.set(candidate.base, await stats.get(candidate.base));
    if (candidate.base === null || existence.get(candidate.base)?.isDirectory) {
      existence.set(candidate.path, await stats.get(candidate.path));
    }
    if (candidateExistence(candidate, lookupExistence) === undefined) return { _tag: "Unverified" };
    const path = selectUnanchoredPath({
      candidates: input.candidates,
      lookupExistence,
      located: null,
    });
    if (path !== null) return { _tag: "Found", path };
  }
  const located = await locating;
  if (located === undefined) return { _tag: "Unverified" };
  if (located && !existence.has(located)) existence.set(located, await settle(input.stat(located)));
  const path = selectUnanchoredPath({ candidates: input.candidates, lookupExistence, located });
  return path === null ? { _tag: "NotFound" } : { _tag: "Found", path };
}
