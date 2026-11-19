/**
 * loom: what the app says about its own build (plans/mobile-self-hosted-updates/plan.mdx §7). One
 * pure decision from the server's update state and the app's build stamp feeds both the home notice
 * and Settings → About, so the two cannot disagree. "Quiet when current; a notice on the home screen
 * only when you must act or an update failed."
 */
import type { LoomMobileApk, LoomMobileAppState, LoomMobileBuild } from "@t3tools/contracts";

/** The commit this APK was built from, written by the deploy's APK build; absent on a hand build. */
export interface LoomBuildStamp {
  readonly sha: string;
  readonly committedAt: string | null;
}

export function readBuildStamp(extra: unknown): LoomBuildStamp | null {
  const stamp = (extra as { loomBuild?: { sha?: unknown; committedAt?: unknown } } | undefined)
    ?.loomBuild;
  if (typeof stamp?.sha !== "string" || stamp.sha === "") return null;
  return {
    sha: stamp.sha,
    committedAt: typeof stamp.committedAt === "string" ? stamp.committedAt : null,
  };
}

/** The server whose state to show: the first holding a stored APK or a build. */
export function pickServerState<T extends { readonly state: LoomMobileAppState }>(
  servers: ReadonlyArray<T>,
): T | null {
  return servers.find(({ state }) => state.apks.length > 0 || state.build !== null) ?? null;
}

export type LoomAppBuildStatus =
  | "current"
  | "ready"
  /** The server offers a build from an earlier commit than this app's: it went back. */
  | "server-earlier"
  | "building"
  | "failed"
  /** The server has no APKs, does not know the method, or nothing decides. */
  | "unknown"
  | "not-connected";

export interface LoomAppBuildView {
  readonly status: LoomAppBuildStatus;
  /** The home notice; null keeps the home screen quiet. */
  readonly notice: "ready" | "server-earlier" | "failed" | "downloading" | null;
  /** The matching APK, when it is not this app's own build. */
  readonly install: LoomMobileApk | null;
  /** A stored APK that is neither this app's nor the matching one, from an earlier commit. */
  readonly goBack: LoomMobileApk | null;
  /** The build behind `building` and `failed`. */
  readonly build: LoomMobileBuild | null;
}

const earlier = (apk: LoomMobileApk, stamp: LoomBuildStamp | null) =>
  stamp?.committedAt != null && Date.parse(apk.committedAt) < Date.parse(stamp.committedAt);

export function loomAppBuildView(input: {
  readonly stamp: LoomBuildStamp | null;
  /** The chosen server's state; null when no connected server has one. */
  readonly server: LoomMobileAppState | null;
  readonly connected: boolean;
  /** The sha of an APK being downloaded by a tap, if any. */
  readonly installing: string | null;
}): LoomAppBuildView {
  const { stamp, server } = input;
  const matching = server?.apks.find((apk) => apk.sha === server.current) ?? null;
  const goBack =
    server?.apks.find(
      (apk) => apk.sha !== stamp?.sha && apk.sha !== matching?.sha && earlier(apk, stamp),
    ) ?? null;
  const build = matching === null ? (server?.build ?? null) : null;
  const status: LoomAppBuildStatus =
    server === null
      ? input.connected
        ? "unknown"
        : "not-connected"
      : matching !== null
        ? matching.sha === stamp?.sha
          ? "current"
          : earlier(matching, stamp)
            ? "server-earlier"
            : "ready"
        : build === null
          ? "unknown"
          : build.failed === null
            ? "building"
            : "failed";
  return {
    status,
    notice:
      input.installing !== null
        ? "downloading"
        : status === "ready" || status === "server-earlier" || status === "failed"
          ? status
          : null,
    install: status === "ready" || status === "server-earlier" ? matching : null,
    goBack,
    build,
  };
}

/** "a1b2c3d" */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** "18 Nov" */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "108 MB" */
export const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
