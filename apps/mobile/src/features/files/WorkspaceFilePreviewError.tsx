import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { environmentCatalog } from "../../connection/catalog";
import type { AssetUrlFailureReason } from "../../state/asset-url-state";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentPresentation } from "../../state/presentation";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";

export function WorkspaceFilePreviewError(props: {
  readonly environmentId: EnvironmentId | null;
  readonly reason: AssetUrlFailureReason;
  readonly path: string; // loom: the absolute path the server checked
  readonly fromRelativeLink: boolean; // loom: a message wrote the path relative
  readonly onRetry: () => void;
}) {
  const { environmentId, onRetry } = props;
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const retryConnection = () => {
    if (environmentId !== null) void retryEnvironment(environmentId);
    onRetry();
  };

  if (props.reason === "disconnected") {
    return (
      <View className="flex-1 bg-sheet">
        <EnvironmentConnectionNotice
          environmentLabel={environment.presentation?.entry.target.label ?? "Environment"}
          connection={
            environment.presentation?.connection ?? {
              phase: "available",
              error: null,
              traceId: null,
            }
          }
          resourceName="preview"
          onRetry={retryConnection}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      {/* loom: say which failure it was; a message's path is often relative to another folder. */}
      <EmptyState
        title={props.reason === "not-found" ? "File not found" : "Preview unavailable"}
        detail={
          props.reason === "not-found"
            ? `There is no file at ${props.path}.${props.fromRelativeLink ? " The message may have given it relative to a different folder." : ""}`
            : props.reason === "missing-file-access"
              ? MISSING_FILE_ACCESS_MESSAGE
              : "The server could not prepare a preview of this file."
        }
        actionLabel="Try again"
        onAction={props.onRetry}
      />
    </View>
  );
}
