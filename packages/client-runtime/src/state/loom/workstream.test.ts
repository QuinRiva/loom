import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workstreamFields, workstreamShell } from "./loomTestFixtures.ts";
import { childrenOf, deriveBoardColumn, workstreamIndexOf } from "./workstream.ts";

const STARTED = "2026-10-05T01:00:00.000Z";
const columnOf = (
  id: string,
  shells: ReadonlyArray<ReturnType<typeof workstreamShell>>,
): ReturnType<typeof deriveBoardColumn> =>
  deriveBoardColumn(
    shells.find((shell) => shell.id === id)!.workstream!,
    workstreamIndexOf(shells),
  );

describe("deriveBoardColumn", () => {
  it("places each sidecar state in its column", () => {
    const shells = [
      workstreamFields("held", { held: true }),
      workstreamFields("dep", { kickoffAt: STARTED }),
      workstreamFields("blocked", { blockedBy: [ThreadId.make("dep")] }),
      workstreamFields("ready"),
      workstreamFields("running", { kickoffAt: STARTED }),
      workstreamFields("done", { kickoffAt: STARTED, outcome: "done" }),
      workstreamFields("cancelled", { outcome: "cancelled" }),
    ].map((fields) => workstreamShell(fields));
    expect(
      ["held", "blocked", "ready", "running", "done", "cancelled"].map((id) =>
        columnOf(id, shells),
      ),
    ).toEqual(["held", "blocked", "ready", "in_progress", "done", "cancelled"]);
  });

  it("releases a dependent whose dependency is done and archived; an archived unfinished one still gates", () => {
    const archived = "2026-10-05T02:00:00.000Z";
    const doneDep = workstreamFields("done-dep", { outcome: "done", archivedAt: archived });
    const liveDep = workstreamFields("live-dep", { kickoffAt: STARTED, archivedAt: archived });
    const shells = [
      workstreamShell(doneDep, { archivedAt: null }),
      workstreamShell(liveDep),
      workstreamShell(workstreamFields("released", { blockedBy: [doneDep.threadId] })),
      workstreamShell(workstreamFields("gated", { blockedBy: [liveDep.threadId] })),
    ];
    expect(columnOf("released", shells)).toBe("ready");
    expect(columnOf("gated", shells)).toBe("blocked");
  });

  it("reads an unbriefed child as blocked and a cancelled dependency as never releasing", () => {
    const shells = [
      workstreamShell(workstreamFields("unbriefed", { kickoffBriefPath: null })),
      workstreamShell(workstreamFields("dead-dep", { outcome: "cancelled" })),
      workstreamShell(workstreamFields("wedged", { blockedBy: [ThreadId.make("dead-dep")] })),
    ];
    expect(columnOf("unbriefed", shells)).toBe("blocked");
    expect(columnOf("wedged", shells)).toBe("blocked");
  });
});

describe("childrenOf", () => {
  it("follows lineage", () => {
    const child = workstreamShell(workstreamFields("child"));
    const grandchild = workstreamShell(
      workstreamFields("grandchild", { parentThreadId: ThreadId.make("child") }),
    );
    expect(childrenOf(ThreadId.make("root"), [child, grandchild]).map((t) => t.id)).toEqual([
      "child",
    ]);
  });
});
