import type { LoomDeployChange, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composeHeadline, pickThread } from "./changes.ts";
import {
  checkoutFastForwardable,
  desiredManagedSkills,
  estimateStopAt,
  type HistoryLine,
  type KeptCopy,
  linkPlan,
  type Manifest,
  markCurrent,
  nextVersion,
  parseSkillFlags,
  planRetention,
  type ReleaseRecord,
} from "./store.ts";

describe("nextVersion", () => {
  it("moves above today's unstamped production number", () => {
    expect(nextVersion("20261112", ["0.1.7"])).toBe("100.20261112.1");
  });

  it("counts up within a day, and never below a version already staged", () => {
    expect(nextVersion("20261112", ["100.20261112.1", "100.20261112.2", "0.1.7"])).toBe(
      "100.20261112.3",
    );
    expect(nextVersion("20261113", ["100.20261112.4"])).toBe("100.20261113.1");
    // A clock behind the last deploy still numbers above it.
    expect(nextVersion("20261111", ["100.20261112.4"])).toBe("100.20261112.5");
  });
});

const record = (id: string, status: ReleaseRecord["status"], builtAt = id): ReleaseRecord => ({
  id,
  ref: "main",
  sha: `${id}-sha`,
  builtAt,
  status,
});
const manifestOf = (...records: ReadonlyArray<ReleaseRecord>): Manifest => ({
  releases: Object.fromEntries(records.map((entry) => [entry.id, entry])),
});
const statuses = (manifest: Manifest) =>
  Object.fromEntries(Object.values(manifest.releases).map((entry) => [entry.id, entry.status]));

describe("markCurrent", () => {
  it("leaves exactly one current and keeps the fields Jacob's refresh reads", () => {
    const next = markCurrent(
      manifestOf(
        record("a", "ready"),
        record("b", "previous"),
        record("c", "current"),
        record("d", "ready"),
      ),
      "d",
    );
    expect(statuses(next)).toEqual({ a: "ready", b: "ready", c: "previous", d: "current" });
    expect(Object.keys(next.releases.d!).toSorted()).toEqual([
      "builtAt",
      "id",
      "ref",
      "sha",
      "status",
    ]);
  });

  it("is a no-op for the release already current, and for one the manifest does not hold", () => {
    const manifest = manifestOf(record("b", "previous"), record("c", "current"));
    expect(markCurrent(manifest, "c")).toBe(manifest);
    expect(markCurrent(manifest, "z")).toBe(manifest);
  });
});

const copy = (updateId: string, at: string, fromRelease: string, toRelease: string): KeptCopy => ({
  updateId,
  fromVersion: "x",
  targetVersion: "y",
  fromRelease,
  toRelease,
  at,
});

describe("planRetention", () => {
  it("keeps the current, the previous and the newest other release", () => {
    const removed = planRetention({
      manifest: manifestOf(
        record("r1", "ready"),
        record("r2", "ready"),
        record("r3", "ready"),
        record("r4", "previous"),
        record("r5", "current"),
      ),
      keepReleases: 3,
      copies: [],
    });
    expect(removed.toSorted()).toEqual(["r1", "r2"]);
  });

  it("never removes a release a kept copy returns to", () => {
    const removed = planRetention({
      manifest: manifestOf(
        record("r1", "ready"),
        record("r2", "ready"),
        record("r3", "ready"),
        record("r4", "previous"),
        record("r5", "current"),
      ),
      keepReleases: 3,
      copies: [
        copy("u2", "2026-11-02T00:00:00Z", "r1", "r2"),
        copy("u4", "2026-11-04T00:00:00Z", "r3", "r4"),
        copy("u5", "2026-11-05T00:00:00Z", "r4", "r5"),
      ],
    });
    expect(removed).toEqual([]);
  });

  it("never removes the current or previous release, however old", () => {
    const removed = planRetention({
      manifest: manifestOf(
        record("old-current", "current", "2020"),
        record("old-previous", "previous", "2021"),
        record("n1", "ready", "2026-1"),
        record("n2", "ready", "2026-2"),
      ),
      keepReleases: 3,
      copies: [],
    });
    expect(removed).toEqual(["n1"]);
  });
});

const line = (startedAt: string, installedAt: string, switchedAt: string): HistoryLine => ({
  id: "r",
  version: null,
  origin: "cli",
  who: null,
  noReturn: false,
  startedAt,
  installedAt,
  switchedAt,
  endedAt: switchedAt,
  outcome: "live",
  reason: null,
});

describe("estimateStopAt", () => {
  it("allows 150 s until there is history", () => {
    expect(estimateStopAt([], "2026-11-12T02:00:00Z")).toBe("2026-11-12T02:02:30Z");
  });

  it("uses the median start-to-stop, then the median of what remains once installed", () => {
    const history = [
      line("2026-11-10T00:00:00Z", "2026-11-10T00:00:30Z", "2026-11-10T00:02:00Z"),
      line("2026-11-10T01:00:00Z", "2026-11-10T01:01:00Z", "2026-11-10T01:03:00Z"),
      line("2026-11-10T02:00:00Z", "2026-11-10T02:00:20Z", "2026-11-10T02:02:20Z"),
    ];
    expect(estimateStopAt(history, "2026-11-12T02:00:00Z")).toBe("2026-11-12T02:02:20Z");
    expect(estimateStopAt(history, "2026-11-12T02:00:00Z", "2026-11-12T02:00:45Z")).toBe(
      "2026-11-12T02:02:45Z",
    );
  });
});

const change = (summary: string | null, kind: LoomDeployChange["kind"]): LoomDeployChange => ({
  pr: 1,
  title: "t",
  summary,
  kind,
  threadId: null as ThreadId | null,
  url: "u",
});

describe("the ported change list", () => {
  it("picks the thread on the most commits, ties to the newest", () => {
    expect(pickThread([["b"], ["a"], ["a", "a"], ["b"], ["a"]])).toBe("a");
    expect(pickThread([["new"], ["old"]])).toBe("new");
    expect(pickThread([[], []])).toBeNull();
  });

  it("heads the notice with the first noticeable summary and a count of the rest", () => {
    expect(composeHeadline([change("Faster sidebar.", "noticeable")])).toBe("Faster sidebar.");
    expect(
      composeHeadline([
        change(null, "noticeable"),
        change("Faster sidebar.", "noticeable"),
        change("Hidden fix", "behind"),
        change("New toast", "noticeable"),
      ]),
    ).toBe("Faster sidebar and 1 more");
    expect(composeHeadline([change("Hidden fix", "behind")])).toBeNull();
  });
});

describe("the ported skill links and checkout refresh", () => {
  it("reads pi_global and both list forms of pi_global_requires", () => {
    expect(
      parseSkillFlags("---\npi_global: true\npi_global_requires: [mdx-doc-core]\n---\n"),
    ).toEqual({
      piGlobal: true,
      requires: ["mdx-doc-core"],
    });
    expect(
      parseSkillFlags(
        "---\npi_global: true\npi_global_requires:\n  - mdx-doc-core\n  - other-ref\n---",
      ),
    ).toEqual({ piGlobal: true, requires: ["mdx-doc-core", "other-ref"] });
    expect(parseSkillFlags("---\npi_global: false\n---")).toEqual({
      piGlobal: false,
      requires: [],
    });
    expect(parseSkillFlags("# no frontmatter\n")).toEqual({ piGlobal: false, requires: [] });
  });

  it("links flagged skills with their dependencies and prunes only what it linked before", () => {
    const desired = desiredManagedSkills([
      { name: "mdx-visual-plan", flags: { piGlobal: true, requires: ["mdx-doc-core"] } },
      { name: "mdx-visual-recap", flags: { piGlobal: true, requires: ["mdx-doc-core"] } },
      { name: "ship", flags: { piGlobal: false, requires: [] } },
    ]);
    expect(desired).toEqual(["mdx-doc-core", "mdx-visual-plan", "mdx-visual-recap"]);
    expect(linkPlan(["mdx-visual-plan"], ["mdx-visual-plan", "mdx-visual-recap"]).prune).toEqual([
      "mdx-visual-recap",
    ]);
    expect(linkPlan(["mdx-visual-plan"], ["mdx-visual-plan"]).prune).toEqual([]);
  });

  it("fast-forwards a checkout only on a clean default branch", () => {
    expect(checkoutFastForwardable("main\n", "main", "")).toBe(true);
    expect(checkoutFastForwardable("feature/x", "main", "")).toBe(false);
    expect(checkoutFastForwardable("HEAD", "main", "")).toBe(false);
    expect(checkoutFastForwardable("main", "main", " M deploy/README.md\n")).toBe(false);
  });
});
