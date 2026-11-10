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
 * Directories named by an explicit directory reference (a trailing separator), in order. An
 * extensionless `README` is a plausible file, never guessed to be a directory.
 */
export function directoryBasesFromPaths(filePaths: Iterable<string>): string[] {
  return [
    ...new Set(
      [...filePaths].flatMap((filePath) =>
        /[\\/]$/.test(filePath) ? [filePath.replace(/[\\/]+$/, "")].filter(Boolean) : [],
      ),
    ),
  ];
}

/** The span's path without its `:line[:col]` suffix: what the index matches. */
export function unanchoredLocateReference(span: string): string {
  return splitFilePathPosition(span.trim().replaceAll("\\", "/")).path;
}

/** Stat candidates in priority order: the root resolution, then the span under each directory. */
export function unanchoredCandidatePaths(
  rootPath: string,
  reference: string,
  directoryBases: readonly string[],
): string[] {
  return [...new Set([rootPath, ...directoryBases.map((base) => `${base}/${reference}`)])];
}

/**
 * The bound path, or null. Candidates bind in order to the first confirmed regular file, and an
 * unverified one blocks the rest so the choice never flips upward; past them the index's unique
 * match binds unless a stat found it gone. `located` is undefined while the index is unanswered,
 * null when it matched none or several, so an ambiguous reference never binds.
 */
export function selectUnanchoredPath(input: {
  readonly candidates: readonly string[];
  readonly lookupExistence: (path: string) => PathExistence | undefined;
  readonly located: string | null | undefined;
}): string | null {
  for (const candidate of input.candidates) {
    const existence = input.lookupExistence(candidate);
    if (existence === undefined) return null;
    if (existence.exists && !existence.isDirectory) return candidate;
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
 * {@link selectUnanchoredPath} run once, for a tap: every candidate stat and the index lookup go
 * out together, then the index's match is stat'd so a file deleted since it was indexed is not
 * opened. `stat` and `locate` resolve undefined when they could not answer.
 */
export async function lookUpUnanchoredFile(input: {
  readonly candidates: readonly string[];
  readonly reference: string;
  readonly stat: (path: string) => Promise<PathExistence | undefined>;
  readonly locate: (reference: string) => Promise<string | null | undefined>;
}): Promise<UnanchoredLookupResult> {
  const existence = new Map<string, PathExistence | undefined>();
  const [, located] = await Promise.all([
    Promise.all(input.candidates.map(async (path) => existence.set(path, await input.stat(path)))),
    input.locate(input.reference),
  ]);
  if (located && !existence.has(located)) existence.set(located, await input.stat(located));
  const lookupExistence = (path: string) => existence.get(path);
  const path = selectUnanchoredPath({ candidates: input.candidates, lookupExistence, located });
  if (path !== null) return { _tag: "Found", path };
  const unverified =
    located === undefined || input.candidates.some((path) => existence.get(path) === undefined);
  return unverified ? { _tag: "Unverified" } : { _tag: "NotFound" };
}
