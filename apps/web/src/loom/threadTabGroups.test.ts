import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isThreadGone, resolveThreadGroupKey, type ThreadTabLineage } from "./threadTabGroups";

const environmentId = EnvironmentId.make("env-1");
const root = ThreadId.make("root");
const child = ThreadId.make("child");
const settled = ThreadId.make("settled-root");
const archived = ThreadId.make("archived");

const lineage = (removed: ReadonlyArray<ThreadId>): ThreadTabLineage =>
  new Map([
    [
      environmentId,
      {
        removed: new Map(removed.map((threadId, index) => [threadId, index + 1])),
        parents: new Map([
          [root, null],
          [child, root],
        ]),
      },
    ],
  ]);

describe("isThreadGone", () => {
  it("keeps a thread the cold shell omits (a settled root) when no removal was seen", () => {
    expect(isThreadGone(lineage([]), { environmentId, threadId: settled })).toBe(false);
  });

  it("prunes a thread the shell saw archived or deleted", () => {
    expect(isThreadGone(lineage([archived]), { environmentId, threadId: archived })).toBe(true);
  });

  it("keeps a removed thread that came back (unarchived)", () => {
    expect(isThreadGone(lineage([child]), { environmentId, threadId: child })).toBe(false);
  });

  it("keeps threads of an environment whose snapshot has not loaded", () => {
    expect(isThreadGone(new Map(), { environmentId, threadId: archived })).toBe(false);
  });
});

describe("resolveThreadGroupKey", () => {
  it("groups a sub-thread under its root and leaves an unknown thread ungrouped", () => {
    expect(resolveThreadGroupKey(lineage([]), { environmentId, threadId: child })).toBe(
      resolveThreadGroupKey(lineage([]), { environmentId, threadId: root }),
    );
    expect(resolveThreadGroupKey(lineage([]), { environmentId, threadId: settled })).toBeNull();
  });
});
