/**
 * loom: the home screen's notice that a new build of the app is ready, the server went back, or the
 * build failed (plans/mobile-self-hosted-updates/plan.mdx §7). Quiet otherwise; it cannot be
 * dismissed and goes when the app matches. Android only: the APKs are Android's.
 */
import { Platform, Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Notice } from "../../components/ui/Notice";
import { megabytes, shortSha } from "./loomAppBuild.loom";
import { useLoomAppBuild } from "./useLoomAppBuild.loom";

export function LoomAppUpdateNotice() {
  return Platform.OS === "android" ? <AndroidNotice /> : null;
}

function AndroidNotice() {
  const { view, install, browserFallback } = useLoomAppBuild();
  const apk = view.install;
  if (view.notice === null) return null;
  const message =
    view.notice === "downloading"
      ? "Downloading the new version…"
      : view.notice === "failed"
        ? "The app is behind Loom and its new version failed to build. Tell an agent; the reason is in Settings, About."
        : view.notice === "server-earlier"
          ? "The server went back to an earlier version of the app. Tap to install it."
          : `A new version of the app is ready. Tap to install build ${apk ? `${shortSha(apk.sha)} (${megabytes(apk.bytes)})` : ""}.`;
  return (
    <View className="gap-2 pb-3">
      <Pressable
        accessibilityRole={apk ? "button" : "text"}
        disabled={apk === null || view.notice === "downloading"}
        onPress={() => apk && install(apk)}
        className="active:opacity-70"
      >
        <Notice
          message={message}
          icon={view.notice === "failed" ? "exclamationmark.triangle" : "arrow.down.circle"}
          tone={view.notice === "failed" ? "danger" : "default"}
        />
      </Pressable>
      {apk && browserFallback ? (
        <Pressable accessibilityRole="button" onPress={browserFallback} hitSlop={8}>
          <AppText textRole="footnote" className="px-3.5 text-foreground-muted underline">
            Download in the browser instead
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
