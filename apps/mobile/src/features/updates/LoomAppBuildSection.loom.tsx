/**
 * loom: Settings → About's "Loom build" rows (plans/mobile-self-hosted-updates/plan.mdx §7): which
 * build this app runs, whether it matches the server's, the install row and the way back.
 */
import { Platform, View } from "react-native";

import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { type LoomAppBuildStatus, megabytes, shortDate, shortSha } from "./loomAppBuild.loom";
import { useLoomAppBuild } from "./useLoomAppBuild.loom";

const HEADLINE: Record<LoomAppBuildStatus, string | null> = {
  current: "Up to date",
  ready: "New version ready",
  "server-earlier": "The server is on an earlier version",
  building: "Behind the server",
  failed: "Update failed",
  unknown: null,
  "not-connected": "Not connected",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function LoomAppBuildSection() {
  return Platform.OS === "android" ? <AndroidSection /> : null;
}

function AndroidSection() {
  const { stamp, view, installing, install, browserFallback } = useLoomAppBuild();
  const { build } = view;
  const thisApp = [
    stamp ? shortSha(stamp.sha) : "Not recorded",
    stamp?.committedAt ? shortDate(stamp.committedAt) : null,
    HEADLINE[view.status],
  ]
    .filter(Boolean)
    .join(" · ");
  const footer =
    build === null
      ? undefined
      : build.failed === null
        ? `Build ${shortSha(build.sha)} is being prepared, since ${clock(build.startedAt)}.`
        : `Update failed: ${build.failed}`;
  return (
    <SettingsSection title="Loom build" {...(footer ? { footer } : {})}>
      <View className="bg-grouped-card">
        <ListRowLayout icon="iphone" label="This app" description={thisApp} />
      </View>
      {[
        { apk: view.install, verb: "Install", icon: "arrow.down.circle" as const },
        { apk: view.goBack, verb: "Go back to", icon: "arrow.uturn.backward" as const },
      ].map(({ apk, verb, icon }) =>
        apk === null ? null : (
          <SettingsRow
            key={apk.sha}
            icon={icon}
            label={`${verb} ${shortSha(apk.sha)}`}
            value={
              installing === apk.sha
                ? "Downloading the new version…"
                : `${shortDate(apk.committedAt)} · ${megabytes(apk.bytes)}`
            }
            disabled={installing !== null}
            onPress={() => install(apk)}
          />
        ),
      )}
      {browserFallback ? (
        <SettingsRow
          icon="safari"
          label="Download in the browser instead"
          onPress={browserFallback.open}
        />
      ) : null}
    </SettingsSection>
  );
}
