import type { EnvironmentId } from "@t3tools/contracts";
import { MessagesSquareIcon } from "lucide-react"; // loom:
import { ContextChipLabel } from "../ContextChip";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

// loom: icon and label for a `#thread` reference; render inside `<ContextChip kind="mention">`
// like a file mention, so a thread chip shares upstream's chip look and metrics.
export function ThreadTagChipContent(props: { label: string }) {
  return (
    <>
      <MessagesSquareIcon aria-hidden="true" />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}

export function FileTagChipContent(props: {
  path: string;
  label: string;
  theme: "light" | "dark";
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
}) {
  return (
    <>
      <WorkspaceEntryIcon
        path={props.path}
        environmentId={props.environmentId}
        cwd={props.cwd}
        theme={props.theme}
      />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}
