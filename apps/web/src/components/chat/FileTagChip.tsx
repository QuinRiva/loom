import { inferEntryKindFromPath } from "../../pierre-icons";
import { MessagesSquareIcon } from "lucide-react";
import { ContextChipLabel } from "../ContextChip";
import { PierreEntryIcon } from "./PierreEntryIcon";

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

/** Icon and label for a file mention; render inside `<ContextChip kind="mention">`. */
export function FileTagChipContent(props: {
  path: string;
  label: string;
  theme: "light" | "dark";
}) {
  return (
    <>
      <PierreEntryIcon
        pathValue={props.path}
        kind={inferEntryKindFromPath(props.path)}
        theme={props.theme}
      />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}
