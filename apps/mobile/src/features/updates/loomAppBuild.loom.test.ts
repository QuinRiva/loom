import type { LoomMobileApk, LoomMobileAppState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loomAppBuildView, pickServerState, readBuildStamp } from "./loomAppBuild.loom";

const apk = (sha: string, committedAt: string): LoomMobileApk => ({
  sha,
  committedAt,
  builtAt: committedAt,
  bytes: 108_000_000,
});
const older = apk("7c9e1f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-11-15T00:00:00Z");
const own = apk("a1b2c3daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-11-18T00:00:00Z");
const newer = apk("9f8e7d6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2026-11-19T00:00:00Z");
const stamp = { sha: own.sha, committedAt: own.committedAt };

const server = (
  apks: ReadonlyArray<LoomMobileApk>,
  current: LoomMobileApk | null,
  build: LoomMobileAppState["build"] = null,
): LoomMobileAppState => ({ apks, current: current?.sha ?? null, build });

const view = (
  state: LoomMobileAppState | null,
  overrides: Partial<Parameters<typeof loomAppBuildView>[0]> = {},
) => loomAppBuildView({ stamp, server: state, connected: true, installing: null, ...overrides });

describe("what the app says about its build (plan §7)", () => {
  it("is quiet when its stamp is the matching APK, and offers the earlier one as the way back", () => {
    const result = view(server([own, older], own));
    expect(result).toMatchObject({ status: "current", notice: null, install: null });
    expect(result.goBack).toBe(older);
  });

  it("shows the new-version notice when the matching APK is a later build", () => {
    expect(view(server([newer, own], newer))).toMatchObject({
      status: "ready",
      notice: "ready",
      install: newer,
      goBack: null,
    });
  });

  it("says the server went back when the matching APK is from an earlier commit than the app's", () => {
    expect(view(server([own, older], older))).toMatchObject({
      status: "server-earlier",
      notice: "server-earlier",
      install: older,
      goBack: null,
    });
  });

  it("stays quiet while the build for the running release is still in flight", () => {
    const build = { sha: newer.sha, startedAt: "2026-11-19T02:31:00Z", failed: null };
    expect(view(server([own], null, build))).toMatchObject({
      status: "building",
      notice: null,
      install: null,
      build,
    });
  });

  it("shows the failure notice when the build failed, including one that ran past 90 minutes", () => {
    // The server records a build running past 90 minutes as failed (apps/server mobileApp.ts).
    const build = {
      sha: newer.sha,
      startedAt: "2026-11-19T02:31:00Z",
      failed: "The build did not finish.",
    };
    expect(view(server([own], null, build))).toMatchObject({
      status: "failed",
      notice: "failed",
      install: null,
      build,
    });
  });

  it("is quiet when the server has no APKs, does not know the method, or is not connected", () => {
    expect(view(null)).toMatchObject({ status: "unknown", notice: null });
    expect(view(null, { connected: false })).toMatchObject({
      status: "not-connected",
      notice: null,
    });
    expect(view(server([older], null))).toMatchObject({ status: "unknown", notice: null });
  });

  it("says it is downloading while a tap is in progress, whatever the state", () => {
    expect(view(server([newer, own], newer), { installing: newer.sha }).notice).toBe("downloading");
    expect(view(server([own, older], own), { installing: older.sha }).notice).toBe("downloading");
  });

  it("treats an app with no stamp as different from whatever the server offers, with no way back", () => {
    expect(view(server([newer, own], newer), { stamp: null })).toMatchObject({
      status: "ready",
      notice: "ready",
      goBack: null,
    });
    expect(view(server([own], own), { stamp: null }).status).toBe("ready");
  });

  it("offers no way back to a later build, nor when the stamp has no commit date", () => {
    expect(view(server([newer, own], own)).goBack).toBeNull();
    expect(
      view(server([own, older], own), { stamp: { sha: own.sha, committedAt: null } }).goBack,
    ).toBeNull();
  });
});

describe("the build stamp and the server chosen", () => {
  it("trusts a stamp only when its sha is a string", () => {
    expect(readBuildStamp({ loomBuild: { sha: own.sha, committedAt: own.committedAt } })).toEqual(
      stamp,
    );
    expect(readBuildStamp({ loomBuild: { sha: own.sha } })).toEqual({
      sha: own.sha,
      committedAt: null,
    });
    expect(readBuildStamp({ loomBuild: {} })).toBeNull();
    expect(readBuildStamp({ appVariant: "preview" })).toBeNull();
    expect(readBuildStamp(undefined)).toBeNull();
  });

  it("uses the first server whose state holds a stored APK or a build", () => {
    const empty = { id: "a", state: server([], null) };
    const holding = { id: "b", state: server([own], own) };
    expect(pickServerState([empty, holding])).toBe(holding);
    expect(pickServerState([empty])).toBeNull();
  });
});
