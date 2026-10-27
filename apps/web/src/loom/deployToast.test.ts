import type { EnvironmentId, LoomDeployChange, LoomDeployNotice } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claimDeployNotice, deployListView, deployNoticeSeenKey } from "./deployToast";

const env = "env-1" as EnvironmentId;
const AT = Date.parse("2026-10-27T22:15:42Z");
const notice = { id: "r1@2026-10-27T22:15:42Z", at: "2026-10-27T22:15:42Z" } as LoomDeployNotice;
const change = (pr: number, kind: LoomDeployChange["kind"]) => ({ pr, kind }) as LoomDeployChange;

describe("claimDeployNotice", () => {
  it("shows a notice once per browser, and a day-old one never", () => {
    const storage = new Map<string, string>();
    const store = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
    expect(claimDeployNotice(store, env, notice, AT + 60_000)).toBe(true);
    expect(claimDeployNotice(store, env, notice, AT + 60_000)).toBe(false);
    storage.delete(deployNoticeSeenKey(env));
    expect(claimDeployNotice(store, env, notice, AT + 25 * 3_600_000)).toBe(false);
    // An expired notice is still marked seen.
    expect(storage.get(deployNoticeSeenKey(env))).toBe(notice.id);
  });
});

describe("deployListView", () => {
  it("lists every noticeable change, fills to eight with the rest, and counts what is left", () => {
    const changes = [
      ...Array.from({ length: 3 }, (_, i) => change(i, "noticeable")),
      ...Array.from({ length: 10 }, (_, i) => change(100 + i, "behind")),
    ];
    const view = deployListView(changes, false);
    expect(view.sections.map((section) => [section.heading, section.changes.length])).toEqual([
      ["You'll notice", 3],
      ["Behind the scenes", 5],
    ]);
    expect(view.hidden).toBe(5);
    expect(deployListView(changes, true).hidden).toBe(0);
  });

  it("puts unclassified changes under one heading", () => {
    const view = deployListView([change(1, null), change(2, null)], false);
    expect(view.sections.map((section) => section.heading)).toEqual(["In this update"]);
  });
});
