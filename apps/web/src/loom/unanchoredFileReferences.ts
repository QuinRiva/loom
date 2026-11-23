import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  directoryBasesFromPaths,
  isAnchoredFileReference,
  selectUnanchoredPath,
  unanchoredCandidatePaths,
  unanchoredLocateReference,
  type UnanchoredCandidate,
} from "@t3tools/client-runtime/unanchored-file-references";
import type { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import type { PathExistence } from "~/components/chat/usePathExistence";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "~/markdown-links";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import { createBatchedLookupStore } from "./batchedLookupStore";

/**
 * Web's adapter over the shared lookup order (`@t3tools/client-runtime/unanchored-file-references`),
 * which the phone also runs on tap: unanchored inline-code references stay plain code until a
 * candidate or the index confirms a file, never "missing?".
 */
export { isAnchoredFileReference, unanchoredLocateReference };

export function collectMessageDirectoryBases(
  messageFileLinkMetas: Iterable<MarkdownFileLinkMeta>,
): string[] {
  return directoryBasesFromPaths([...messageFileLinkMetas].map(({ filePath }) => filePath));
}

function positionSuffix(span: string): string {
  const { line, column } = splitFilePathPosition(span.trim());
  return line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`;
}

/** A stat candidate with the chip it would render. */
export interface UnanchoredCandidateMeta extends UnanchoredCandidate {
  readonly meta: MarkdownFileLinkMeta;
}

/** Ordered stat candidates for an unanchored span: `rootMeta` first. */
export function unanchoredCandidates(
  span: string,
  rootMeta: MarkdownFileLinkMeta,
  directoryBases: readonly string[],
  cwd: string | undefined,
): UnanchoredCandidateMeta[] {
  const position = positionSuffix(span);
  const candidates: UnanchoredCandidateMeta[] = [
    { path: rootMeta.filePath, base: null, meta: rootMeta },
  ];
  for (const { path, base } of unanchoredCandidatePaths(
    rootMeta.filePath,
    unanchoredLocateReference(span),
    directoryBases,
  ).slice(1)) {
    const meta = resolveMarkdownFileLinkMeta(`${path}${position}`, cwd);
    if (meta && !candidates.some((candidate) => candidate.path === meta.filePath)) {
      candidates.push({ path: meta.filePath, base, meta });
    }
  }
  return candidates;
}

/** The chip target for an unanchored span, or null for plain code; see `selectUnanchoredPath`. */
export function selectUnanchoredBinding(input: {
  candidates: readonly UnanchoredCandidateMeta[];
  lookupExistence: (filePath: string) => PathExistence | undefined;
  located: string | null | undefined;
  span: string;
  cwd: string | undefined;
}): MarkdownFileLinkMeta | null {
  const path = selectUnanchoredPath(input);
  if (path === null) return null;
  const candidate = input.candidates.find((candidate) => candidate.path === path);
  if (candidate) return candidate.meta;
  return resolveMarkdownFileLinkMeta(`${path}${positionSuffix(input.span)}`, input.cwd);
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
