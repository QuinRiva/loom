import { describe, expect, it } from "@effect/vitest";

import {
  lookUpUnanchoredFile,
  type PathExistence,
  unanchoredCandidatePaths,
} from "./unanchoredFileReferences.loom.ts";

const FILE: PathExistence = { exists: true, isDirectory: false };
const DIRECTORY: PathExistence = { exists: true, isDirectory: true };
const MISSING: PathExistence = { exists: false, isDirectory: false };

const ROOT = "/wt";
const REFERENCE = "viz/pages/index.html";
const NAMED = "/checkout/study";

// A tap's lookup against a fake host: `undefined` in either map is a call that could not answer.
function lookUp(
  existence: Record<string, PathExistence | undefined>,
  located: string | null | undefined,
  directoryBases: string[] = [NAMED],
) {
  return lookUpUnanchoredFile({
    candidates: unanchoredCandidatePaths(`${ROOT}/${REFERENCE}`, REFERENCE, directoryBases),
    reference: REFERENCE,
    stat: async (path) => (path in existence ? existence[path] : MISSING),
    locate: async () => located,
  });
}

describe("lookUpUnanchoredFile", () => {
  it("prefers the root, then the folders the message names, then the index", async () => {
    const atNamed = `${NAMED}/${REFERENCE}`;
    const indexed = `${ROOT}/study/${REFERENCE}`;
    expect(await lookUp({ [`${ROOT}/${REFERENCE}`]: FILE, [atNamed]: FILE }, indexed)).toEqual({
      _tag: "Found",
      path: `${ROOT}/${REFERENCE}`,
    });
    expect(await lookUp({ [atNamed]: FILE }, indexed)).toEqual({ _tag: "Found", path: atNamed });
    expect(await lookUp({ [indexed]: FILE }, indexed)).toEqual({ _tag: "Found", path: indexed });
  });

  it("opens a confirmed candidate without waiting on an index that is still scanning", async () => {
    const result = await lookUpUnanchoredFile({
      candidates: [`${ROOT}/${REFERENCE}`],
      reference: REFERENCE,
      stat: async () => FILE,
      locate: () => new Promise(() => {}),
    });
    expect(result).toEqual({ _tag: "Found", path: `${ROOT}/${REFERENCE}` });
  });

  it("does not open a directory in place of a file", async () => {
    expect(await lookUp({ [`${ROOT}/${REFERENCE}`]: DIRECTORY }, null)).toEqual({
      _tag: "NotFound",
    });
  });

  // The server's index answers null for none and for several matches alike.
  it("is not found when nothing matches or the match is ambiguous, never a guess", async () => {
    expect(await lookUp({}, null)).toEqual({ _tag: "NotFound" });
  });

  it("does not open an index match that has been deleted since it was indexed", async () => {
    const indexed = `${ROOT}/study/${REFERENCE}`;
    expect(await lookUp({ [indexed]: MISSING }, indexed)).toEqual({ _tag: "NotFound" });
  });

  it("reports a failed stat or index call as unverified, not as not found", async () => {
    expect(await lookUp({ [`${ROOT}/${REFERENCE}`]: undefined }, null)).toEqual({
      _tag: "Unverified",
    });
    expect(await lookUp({}, undefined)).toEqual({ _tag: "Unverified" });
  });
});
