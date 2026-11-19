/**
 * loom: the app's build against the server's (plans/mobile-self-hosted-updates/plan.mdx §5, §7).
 * Subscribes on every environment, shows the first whose state holds a stored APK or a build, and
 * installs by handing the downloaded APK to Android's installer. The subscription opens with the
 * screen that asks, never at start-up.
 */
import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { createLoomCommandAtoms } from "@t3tools/client-runtime/state/loom/goalCommands";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LoomMobileApk, LoomMobileAppState } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { Linking } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { openAttachmentInViewer } from "../../lib/attachmentDownload";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { loomAppBuildView, pickServerState, readBuildStamp, shortSha } from "./loomAppBuild.loom";

const loomCommands = createLoomCommandAtoms(connectionAtomRuntime);
const stamp = readBuildStamp(Constants.expoConfig?.extra);

/** Shared by the home notice and About, so a tap in one shows as downloading in the other. */
const installingAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);
/** The APK whose install returned to the app: cancelled, or the installer never opened. */
const browserFallbackAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly sha: string;
} | null>(null).pipe(Atom.keepAlive);

async function signedApkUrl(environmentId: EnvironmentId, sha: string): Promise<string> {
  const result = await runAtomCommand(
    appAtomRegistry,
    loomCommands.mobileApkUrl,
    { environmentId, input: { sha } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const prepared = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const url = Option.isSome(prepared)
    ? resolveAssetUrl(prepared.value.httpBaseUrl, result.value.relativeUrl)
    : null;
  if (url === null) throw new Error("The app is not connected to Loom.");
  return url;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Check the connection and try again.";

async function install(environmentId: EnvironmentId, apk: LoomMobileApk) {
  if (appAtomRegistry.get(installingAtom) !== null) return;
  appAtomRegistry.set(installingAtom, apk.sha);
  appAtomRegistry.set(browserFallbackAtom, null);
  try {
    await openAttachmentInViewer({
      uri: await signedApkUrl(environmentId, apk.sha),
      attachment: {
        name: `loom-${shortSha(apk.sha)}.apk`,
        mimeType: "application/vnd.android.package-archive",
      },
      signal: new AbortController().signal,
    });
    // A completed install replaces the app; returning here means it did not happen.
    appAtomRegistry.set(browserFallbackAtom, { environmentId, sha: apk.sha });
  } catch (error) {
    appAtomRegistry.set(browserFallbackAtom, { environmentId, sha: apk.sha });
    Dialog.alert("Could not install the new version", message(error));
  } finally {
    appAtomRegistry.set(installingAtom, null);
  }
}

async function openInBrowser(environmentId: EnvironmentId, sha: string) {
  try {
    await Linking.openURL(await signedApkUrl(environmentId, sha));
  } catch (error) {
    Dialog.alert("Could not open the download", message(error));
  }
}

export function useLoomAppBuild() {
  const { environments } = useEnvironments();
  const idsKey = environments.map((environment) => environment.environmentId).join("\n");
  const serversAtom = useMemo(
    () =>
      Atom.make((get) =>
        (idsKey === "" ? [] : (idsKey.split("\n") as EnvironmentId[])).flatMap((environmentId) => {
          const result = get(loomCommands.mobileApp({ environmentId, input: {} }));
          const state: LoomMobileAppState | null = Option.getOrNull(AsyncResult.value(result));
          return state === null ? [] : [{ environmentId, state }];
        }),
      ),
    [idsKey],
  );
  const chosen = pickServerState(useAtomValue(serversAtom));
  const installing = useAtomValue(installingAtom);
  const fallback = useAtomValue(browserFallbackAtom);
  const view = loomAppBuildView({
    stamp,
    server: chosen?.state ?? null,
    connected: environments.some((environment) => environment.connection.phase === "connected"),
    installing,
  });
  const environmentId = chosen?.environmentId ?? null;
  return {
    stamp,
    view,
    installing,
    install: (apk: LoomMobileApk) =>
      environmentId === null ? undefined : void install(environmentId, apk),
    /** The hedge for an installer that did not open: the same file through the phone's browser. */
    browserFallback:
      fallback === null || installing !== null
        ? null
        : {
            sha: fallback.sha,
            open: () => void openInBrowser(fallback.environmentId, fallback.sha),
          },
  };
}
