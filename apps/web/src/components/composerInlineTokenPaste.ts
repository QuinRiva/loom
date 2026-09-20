import {
  type ComposerInlineToken,
  collectComposerInlineTokens,
} from "@t3tools/shared/composerInlineTokens";
import {
  $createLineBreakNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

interface ComposerInlineTokenPasteOptions {
  createMentionNode: (path: string) => LexicalNode;
  getExpandedAbsoluteOffsetForPoint: (node: LexicalNode, pointOffset: number) => number;
}
import { ComposerContextId } from "@t3tools/contracts";
import type { ComposerContextClipboardFragment } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
/** Clipboard records referenced by the copied text, including dependent screenshots. */
export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
): ComposerContextClipboardFragment | null {
  const pastedText = clipboardData.getData("text/plain");
  // Only records whose links are in the pasted text get imported; a fragment may carry
  // more (it was built for a larger copy) and must not start transfers for those.
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  if (decodedFragment === null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(pastedText).map((occurrence) => occurrence.contextId),
  );
  for (const record of decodedFragment.records) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
  }
  return {
    ...decodedFragment,
    records: decodedFragment.records.filter((record) => pastedIds.has(record.contextId)),
  };
}

export function registerComposerInlineTokenPaste(
  editor: LexicalEditor,
  options: ComposerInlineTokenPasteOptions,
): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      if (!(event instanceof ClipboardEvent) || event.clipboardData === null) {
        return false;
      }
      if (event.clipboardData.files.length > 0) {
        return false;
      }
      const text = event.clipboardData.getData("text/plain");
      if (text.length === 0) {
        return false;
      }
      // Token grammar requires trailing whitespace; a virtual newline lets a
      // mention at the very end of the pasted text still parse.
      const mentions = collectComposerInlineTokens(`${text}\n`).filter(
        // loom: narrow to the mention arm so `mention.value` is well-typed — the
        // fork's ComposerInlineToken union adds a `thread` variant with no
        // `value` field, so a boolean filter would leave the element unnarrowed.
        (token): token is Extract<ComposerInlineToken, { type: "mention" }> =>
          token.type === "mention" && token.end <= text.length,
      );
      if (mentions.length === 0) {
        return false;
      }

      // Lexical command listeners already run inside an editor update. Starting
      // a nested update here queues the mention insertion until after this
      // listener returns, which lets the plain-text paste handler run as well.
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return false;
      }
      const nodes: LexicalNode[] = [];
      const appendText = (value: string) => {
        const lines = value.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line.length > 0) {
            nodes.push($createTextNode(line));
          }
          if (index < lines.length - 1) {
            nodes.push($createLineBreakNode());
          }
        }
      };
      const firstMention = mentions[0];
      if (firstMention && firstMention.start === 0) {
        const startPoint = selection.isBackward() ? selection.focus : selection.anchor;
        const insertionOffset = options.getExpandedAbsoluteOffsetForPoint(
          startPoint.getNode(),
          startPoint.offset,
        );
        const precedingChar = $getRoot()
          .getTextContent()
          .slice(insertionOffset - 1, insertionOffset);
        if (precedingChar.length > 0 && !/\s/.test(precedingChar)) {
          nodes.push($createTextNode(" "));
        }
      }
      let cursor = 0;
      for (const mention of mentions) {
        if (mention.start < cursor) {
          continue;
        }
        if (mention.start > cursor) {
          appendText(text.slice(cursor, mention.start));
        }
        nodes.push(options.createMentionNode(mention.value));
        cursor = mention.end;
      }
      if (cursor < text.length) {
        appendText(text.slice(cursor));
      } else {
        // Keep the serialized prompt valid: mention tokens need trailing
        // whitespace, so a paste ending in a mention gets the same
        // trailing space the autocomplete inserts.
        nodes.push($createTextNode(" "));
      }
      selection.insertNodes(nodes);
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

/** Imports the same structured clipboard payload for focused paste and paste-to-focus. */
export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
): string {
  export const pastedText = clipboardData.getData("text/plain");
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
  const text =
    rewrittenIds && rewrittenIds.size > 0
      ? replaceComposerContextReferences(pastedText, (occurrence) => {
          const nextId = rewrittenIds.get(occurrence.contextId);
          return nextId
            ? formatComposerContextReference({
                ...occurrence,
                contextId: ComposerContextId.make(nextId),
                kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
              })
            : occurrence.source;
        })
      : pastedText;
  return text;
}
