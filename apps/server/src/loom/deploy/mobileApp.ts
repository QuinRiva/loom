/**
 * The phone app's update state as the server sees it (plans/mobile-self-hosted-updates/plan.mdx §3, §5).
 * `loom-deploy` writes `mobile-app.json`; this module only reads it, streams it without the file
 * paths, and signs and resolves the session-less download link. None of it depends on whether this
 * server can deploy itself, so a dev server pointed at a hand-written file serves the same.
 */
import { LoomMobileAppFile, LoomMobileAppState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AssetSigner } from "../../assets/AssetSigner.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../../auth/utils.ts";

export const MOBILE_APK_ROUTE = "/loom/mobile/apk";
const LINK_TTL_MS = 15 * 60_000;
/** A build recorded as running longer than this died with its unit (a reboot, a kill). */
export const BUILD_GIVE_UP_MS = 90 * 60_000;
const POLL_INTERVAL = "5 seconds";

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(LoomMobileAppFile));
const LinkClaims = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal("loom-mobile-apk"),
    sha: Schema.String,
    expiresAt: Schema.Number,
  }),
);
const encodeClaims = Schema.encodeSync(LinkClaims);
const decodeClaims = Schema.decodeUnknownOption(LinkClaims);
const sameState = Schema.toEquivalence(LoomMobileAppState);

const EMPTY: LoomMobileAppState = { apks: [], current: null, build: null };

/** The stream's value: the file without its paths, a stale running build read as failed. */
export const mobileAppState = (file: LoomMobileAppFile | null, now: number): LoomMobileAppState => {
  if (file === null) return EMPTY;
  const { build } = file;
  return {
    apks: file.apks.map(({ file: _, ...apk }) => apk),
    current: file.current,
    build:
      build !== null &&
      build.failed === null &&
      now - Date.parse(build.startedAt) > BUILD_GIVE_UP_MS
        ? { ...build, failed: "The build did not finish." }
        : build,
  };
};

const apkFileName = (sha: string) => `loom-${sha.slice(0, 7)}.apk`;

export const makeMobileApp = Effect.fn("LoomMobileApp.make")(function* (statePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const signer = yield* AssetSigner;
  // Decoded once per change of the text, so a malformed file warns once, not on every poll.
  const last = yield* Ref.make<{ text: string | null; file: LoomMobileAppFile | null }>({
    text: null,
    file: null,
  });
  const read = Effect.gen(function* () {
    const text = yield* fileSystem.readFileString(statePath).pipe(Effect.orElseSucceed(() => null));
    const cached = yield* Ref.get(last);
    if (text === cached.text) return cached.file;
    const file =
      text === null
        ? null
        : yield* decodeFile(text).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("mobile app file unreadable; ignored", { statePath, cause }),
            ),
            Effect.orElseSucceed(() => null),
          );
    yield* Ref.set(last, { text, file });
    return file;
  });

  const state = Stream.tick(POLL_INTERVAL).pipe(
    Stream.mapEffect(() =>
      Effect.zipWith(read, Clock.currentTimeMillis, (file, now) => mobileAppState(file, now)),
    ),
    Stream.changesWith(sameState),
  );

  /** A link to the stored APK built from `sha`, or None when no such APK is stored. */
  const apkUrl = Effect.fn("LoomMobileApp.apkUrl")(function* (sha: string) {
    if ((yield* read)?.apks.some((apk) => apk.sha === sha) !== true) return Option.none();
    const expiresAt = (yield* Clock.currentTimeMillis) + LINK_TTL_MS;
    const payload = base64UrlEncode(encodeClaims({ kind: "loom-mobile-apk", sha, expiresAt }));
    const signature = yield* signer.sign(payload);
    return Option.some({
      relativeUrl: `${MOBILE_APK_ROUTE}/${payload}.${signature}/${apkFileName(sha)}`,
      expiresAt,
    });
  });

  /** The stored file a link's token names; None when forged, expired or no longer stored. */
  const apkFile = Effect.fn("LoomMobileApp.apkFile")(function* (token: string) {
    const [payload = "", signature = ""] = token.split(".");
    const verified = yield* signer
      .verify(payload, signature)
      .pipe(Effect.orElseSucceed(() => false));
    if (!verified) return Option.none<string>();
    const claims = Option.flatMap(Option.liftThrowable(base64UrlDecodeUtf8)(payload), decodeClaims);
    if (Option.isNone(claims) || claims.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return Option.none<string>();
    }
    return Option.fromNullishOr(
      (yield* read)?.apks.find((apk) => apk.sha === claims.value.sha)?.file,
    );
  });

  return { state, apkUrl, apkFile };
});
