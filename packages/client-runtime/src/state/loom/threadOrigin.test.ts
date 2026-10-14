import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workstreamFields, workstreamShell } from "./loomTestFixtures.ts";
import { threadStartOf, threadStartOriginOf } from "./threadOrigin.ts";

const PREDECESSOR = ThreadId.make("predecessor");
const STARTED = "2026-10-05T01:00:00.000Z";
// A `goal_continue` successor: an agent-created root continuing its predecessor, held until launched.
const continuation = (overrides: Parameters<typeof workstreamFields>[1] = {}) =>
  workstreamShell(
    workstreamFields("successor", {
      parentThreadId: null,
      rootThreadId: ThreadId.make("successor"),
      continuesThreadId: PREDECESSOR,
      held: true,
      ...overrides,
    }),
    { createdBy: "agent" },
  );

describe("threadStartOf", () => {
  it("marks a goal_continue successor while held and after an unedited launch", () => {
    for (const shell of [
      continuation(),
      continuation({ held: false, kickoffAt: STARTED, kickoffOrigin: "kickoff" }),
    ]) {
      expect(threadStartOf(shell)).toBe("continued");
      expect(threadStartOriginOf(shell.workstream)).toEqual({
        start: "continued",
        threadId: PREDECESSOR,
      });
    }
  });

  it("drops the rail once the human edited the brief, or the launch predates the record", () => {
    for (const kickoffOrigin of ["user", null] as const) {
      const shell = continuation({ held: false, kickoffAt: STARTED, kickoffOrigin });
      expect(threadStartOf(shell)).toBeNull();
      expect(threadStartOriginOf(shell.workstream)).toBeNull();
    }
  });

  it("keeps the handoff and scheduled-task kinds, and leaves the human's roots and children alone", () => {
    const root = (overrides: Parameters<typeof workstreamFields>[1]) =>
      workstreamFields("root", { parentThreadId: null, ...overrides });
    const origin = (initiatedBy: "agent" | "human") => ({
      handoffOrigin: { threadId: PREDECESSOR, initiatedBy },
    });
    expect(threadStartOf(workstreamShell(root(origin("agent"))))).toBe("agent");
    expect(threadStartOf(workstreamShell(root(origin("human"))))).toBe("requested");
    expect(threadStartOf(workstreamShell(root({}), { createdBy: "agent" }))).toBe("agent");
    expect(threadStartOf(workstreamShell(root({}), { createdBy: "user" }))).toBeNull();
    expect(threadStartOf(workstreamShell(workstreamFields("child"), { createdBy: "agent" }))).toBe(
      null,
    );
  });
});
