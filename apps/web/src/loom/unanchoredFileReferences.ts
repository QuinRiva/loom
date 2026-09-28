import { splitFilePathPosition } from "@t3tools/client-runtime/markdown-links";
import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import type { PathExistence } from "~/components/chat/usePathExistence";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "~/markdown-links";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import { createBatchedLookupStore } from "./batchedLookupStore";

/**
 * Unanchored inline-code file references — a bare `prices.json`, an unprefixed
 * `src/models/chain_models.py:61`. Agents write these relative to wherever they
 * last `cd`'d, which the renderer cannot know, so joining them onto the
 * worktree root is a guess, and a wrong guess is not evidence the file is gone.
 * They therefore get the scanners' polarity: plain code until a file is
 * confirmed, never a "missing?" chip. Resolution tries, in order, the base
 * directory (the worktree root, or a rendered markdown file's own directory),
 * each directory the same message names, and finally the workspace path index,
 * which binds only when exactly one indexed file matches.
 *
 * Anchored references — absolute, `~/`, `./`, `../` — name one place, so they
 * keep the optimistic chip that says "missing?" when that place is empty.
 */
export function isAnchoredFileReference(text: string): boolean {
  const normalized = text.trim().replaceAll("\\", "/");
  return /^(?:\/|[A-Za-z]:\/|~\/|\.{1,2}\/|[A-Za-z][\w+.-]*:\/\/)/.test(normalized);
}

/**
 * Directories a message names by an explicit directory reference — a trailing
 * separator (`~/reports/gold/`, `[out](/abs/_findings/)`) — in the order given,
 * so a bare `verdict.md` beside a named `_findings/` folder resolves there. An
 * extensionless `README` is a plausible file, never guessed to be a directory.
 */
export function collectMessageDirectoryBases(
  messageFileLinkMetas: Iterable<MarkdownFileLinkMeta>,
): string[] {
  return [
    ...new Set(
      [...messageFileLinkMetas].flatMap(({ filePath }) =>
        /[\\/]$/.test(filePath) ? [filePath.replace(/[\\/]+$/, "")].filter(Boolean) : [],
      ),
    ),
  ];
}

/**
 * Ordered stat candidates for an unanchored span: `rootMeta` (its resolution
 * against the base directory) first, then the span under each message
 * directory.
 */
export function unanchoredCandidates(
  span: string,
  rootMeta: MarkdownFileLinkMeta,
  directoryBases: readonly string[],
  cwd: string | undefined,
): MarkdownFileLinkMeta[] {
  const text = span.trim().replaceAll("\\", "/");
  const candidates = [rootMeta];
  for (const directory of directoryBases) {
    const meta = resolveMarkdownFileLinkMeta(`${directory}/${text}`, cwd);
    if (meta && !candidates.some((candidate) => candidate.filePath === meta.filePath)) {
      candidates.push(meta);
    }
  }
  return candidates;
}

/** The span's path without its `:line[:col]` suffix — what the index matches. */
export function unanchoredLocateReference(span: string): string {
  return splitFilePathPosition(span.trim().replaceAll("\\", "/")).path;
}

/**
 * The chip target for an unanchored span, or null to render plain code.
 * Candidates bind in priority order to the first confirmed regular file; one
 * still unverified blocks the rest, so the choice never flips from a lower- to
 * a higher-priority target. Past them, the index's unique match binds unless a
 * stat has since found it gone. `located` is undefined while the index has not
 * answered and null when it matched none or several.
 */
export function selectUnanchoredBinding(input: {
  candidates: readonly MarkdownFileLinkMeta[];
  lookupExistence: (filePath: string) => PathExistence | undefined;
  located: string | null | undefined;
  span: string;
  cwd: string | undefined;
}): MarkdownFileLinkMeta | null {
  for (const meta of input.candidates) {
    const existence = input.lookupExistence(meta.filePath);
    if (existence === undefined) return null;
    if (existence.exists && !existence.isDirectory) return meta;
  }
  if (!input.located || input.lookupExistence(input.located)?.exists === false) return null;
  const { line, column } = splitFilePathPosition(input.span.trim());
  const position = line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`;
  return resolveMarkdownFileLinkMeta(`${input.located}${position}`, input.cwd);
}

// "\n" cannot appear in a path, so it separates the workspace from the reference.
export const locateFileKey = (cwd: string, reference: string) => `${cwd}\n${reference}`;

async function fetchLocatedFiles(
  environmentId: EnvironmentId,
  keys: string[],
): Promise<ReadonlyMap<string, string | null>> {
  const referencesByCwd = new Map<string, string[]>();
  for (const key of keys) {
    const separator = key.indexOf("\n");
    const cwd = key.slice(0, separator);
    referencesByCwd.set(cwd, [...(referencesByCwd.get(cwd) ?? []), key.slice(separator + 1)]);
  }
  const answers = new Map<string, string | null>();
  await Promise.all(
    [...referencesByCwd].map(async ([cwd, references]) => {
      const atom = projectEnvironment.locateFiles({ environmentId, input: { cwd, references } });
      // Freshness is the store's job, as for stats (see usePathExistence).
      const result = await executeAtomQuery(appAtomRegistry, atom, {
        refresh: true,
        reportDefect: false,
        reportFailure: false,
      });
      if (result._tag !== "Success") return;
      for (const { reference, path } of result.value.entries) {
        answers.set(locateFileKey(cwd, reference), path);
      }
    }),
  );
  return answers;
}

/**
 * Index lookups, batched and revalidated exactly like path stats. The batch cap
 * matches ProjectLocateFilesInput: each reference is one pass over the index,
 * and the server runs them synchronously.
 */
export const locatedFileStore = createBatchedLookupStore<string | null>({
  fetch: fetchLocatedFiles,
  batchMax: 50,
});
