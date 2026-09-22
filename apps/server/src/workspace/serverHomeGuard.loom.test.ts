import { describe, expect, it } from "@effect/vitest";

import { classifyRuntimeHolder, selectServerBaseDir } from "./serverHomeGuard.loom.ts";

const COCKPIT = "/home/carl/.t3/cockpit";
const WORKTREE = `${COCKPIT}/worktrees/t3code-ea251a06/ws-guard`;

describe("selectServerBaseDir", () => {
  it("lets --base-dir win over everything", () => {
    expect(
      selectServerBaseDir({
        flagBaseDir: "/tmp/explicit",
        envHome: COCKPIT,
        defaultHome: "/home/carl/.t3",
        worktreePath: WORKTREE,
      }),
    ).toMatchObject({ baseDir: "/tmp/explicit", rule: "flag" });
  });

  it("gives a worktree this install provisioned its own .t3, outranking T3CODE_HOME", () => {
    expect(
      selectServerBaseDir({
        envHome: COCKPIT,
        defaultHome: "/home/carl/.t3",
        worktreePath: WORKTREE,
      }),
    ).toEqual({ baseDir: `${WORKTREE}/.t3`, rule: "worktree", displacedHome: COCKPIT });
  });

  it("leaves an unrelated worktree on T3CODE_HOME (the deployed release tree)", () => {
    // `~/loom-releases/current` is a linked worktree of the release repo, and
    // deployctl's smoke boot runs from one too. Neither was provisioned by the
    // home they run against, so both keep their configured home.
    expect(
      selectServerBaseDir({
        envHome: COCKPIT,
        defaultHome: "/home/carl/.t3",
        worktreePath: "/home/carl/loom-releases/releases/20260922-051919-576d1e8",
      }),
    ).toEqual({ baseDir: COCKPIT, rule: "env" });
  });

  it("falls through T3CODE_HOME, the bootstrap envelope, then ~/.t3", () => {
    expect(selectServerBaseDir({ envHome: COCKPIT, defaultHome: "/home/carl/.t3" })).toEqual({
      baseDir: COCKPIT,
      rule: "env",
    });
    expect(
      selectServerBaseDir({ bootstrapHome: "/tmp/desktop", defaultHome: "/home/carl/.t3" }),
    ).toEqual({ baseDir: "/tmp/desktop", rule: "bootstrap" });
    expect(selectServerBaseDir({ defaultHome: "/home/carl/.t3" })).toEqual({
      baseDir: "/home/carl/.t3",
      rule: "default",
    });
  });

  it("applies the worktree rule against the default home too", () => {
    expect(
      selectServerBaseDir({
        defaultHome: "/home/carl/.t3",
        worktreePath: "/home/carl/.t3/worktrees/feature",
      }),
    ).toMatchObject({ baseDir: "/home/carl/.t3/worktrees/feature/.t3", rule: "worktree" });
  });
});

describe("classifyRuntimeHolder", () => {
  const holder = { holderPid: 4242, selfPid: 99, alive: true, cmdline: undefined };

  it("treats a dead pid as free so a stale lockfile is overwritten", () => {
    expect(classifyRuntimeHolder({ ...holder, alive: false, cmdline: "node bin.mjs" })).toBe(
      "free",
    );
  });

  it("refuses a live server pid, from source or from the bundle", () => {
    expect(
      classifyRuntimeHolder({
        ...holder,
        cmdline: "node apps/server/src/bin.ts serve --port 47311",
      }),
    ).toBe("held");
    expect(
      classifyRuntimeHolder({
        ...holder,
        cmdline: "/home/carl/.n/bin/node apps/server/dist/bin.mjs",
      }),
    ).toBe("held");
  });

  it("ignores a live pid that is plainly not a server (recycled pid)", () => {
    expect(classifyRuntimeHolder({ ...holder, cmdline: "sleep 600" })).toBe("free");
  });

  it("treats an unreadable command line as held, and our own pid as free", () => {
    expect(classifyRuntimeHolder(holder)).toBe("held");
    expect(classifyRuntimeHolder({ ...holder, holderPid: 99 })).toBe("free");
  });
});
