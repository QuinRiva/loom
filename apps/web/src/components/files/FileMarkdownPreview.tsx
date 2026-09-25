import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";

// loom: one notion of "the directory a document's relative paths resolve against",
// shared with the `.mdx` renderer's `<Image>` block.
import { documentBaseDir } from "./mdx-plan/planDocument";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.cwd}
      imageBaseDir={documentBaseDir(props.relativePath, props.cwd)}
      threadRef={props.threadRef}
      className="mx-auto max-w-4xl px-6 py-5"
      onTaskListChange={props.onTaskListChange}
    />
  );
}
