import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import type { AssetUrlFailureReason } from "../../state/asset-url-state";
import { useEnvironmentPresentation } from "../../state/presentation";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useRetryEnvironment } from "../connection/useRetryEnvironment";

export function WorkspaceFilePreviewError(props: {
  readonly environmentId: EnvironmentId | null;
  readonly reason: AssetUrlFailureReason;
  readonly path: string; // loom: the absolute path the server checked
  readonly fromRelativeLink: boolean; // loom: a message wrote the path relative
  readonly onRetry: () => void;
}) {
  const { environmentId, onRetry } = props;
  const gt = useGT();
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useRetryEnvironment();
  const retryConnection = () => {
    if (environmentId !== null) void retryEnvironment(environmentId);
    onRetry();
  };

  if (props.reason === "disconnected") {
    return (
      <View className="flex-1 bg-sheet">
        <EnvironmentConnectionNotice
          environmentLabel={
            environment.presentation?.entry.target.label ??
            gt("Environment", { $context: "fallback environment name" })
          }
          connection={
            environment.presentation?.connection ?? {
              phase: "available",
              error: null,
              traceId: null,
            }
          }
          resource="preview"
          onRetry={retryConnection}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      {/* loom: say which failure it was; a message's path is often relative to another folder. */}
      <EmptyState
        title={props.reason === "not-found" ? gt("File not found") : gt("Preview unavailable")}
        detail={
          props.reason === "not-found"
            ? props.fromRelativeLink
              ? `${gt("There is no file at {path}.", { path: props.path })} ${gt("The message may have given it relative to a different folder.")}`
              : gt("There is no file at {path}.", { path: props.path })
            : props.reason === "missing-file-access"
              ? MISSING_FILE_ACCESS_MESSAGE
              : gt("The server could not prepare a preview of this file.")
        }
        actionLabel={gt("Try again")}
        onAction={props.onRetry}
      />
    </View>
  );
}
