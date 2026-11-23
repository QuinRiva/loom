/**
 * loom: the card a control-plane arrival collapses to in the thread feed, web's
 * `ControlDigestCard` redrawn for touch: two lines per sub-thread, and no markdown until expanded.
 * An entry opens its report, its arrow the sub-thread; the raw text is one tap past the excerpts.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  controlDocumentLabel,
  type ControlCardItem,
  type ControlCardModel,
  type ControlSeverity,
} from "@t3tools/client-runtime/state/loom/controlCard";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { openReport } from "../workstream/workstreamNavigation.loom";
import { ThreadDisclosureChevron } from "./thread-work-log";
import { useOpenThreadLink } from "./useOpenThreadLink";

/** Which channel it came from: a symbol, never a colour (web's inbox / speech bubbles). */
const CHANNEL_SYMBOLS: Record<ControlCardModel["channel"], AppSymbolName> = {
  "control-plane": "tray",
  "inter-thread": "bubble.left.and.bubble.right",
};

/** Colour says whether the human must act: neutral unless they must. */
const SEVERITY_CLASSES: Record<ControlSeverity, { border: string; text: string; tint: string }> = {
  neutral: {
    border: "border-border",
    text: "text-foreground-muted",
    tint: "accent-foreground-muted",
  },
  warning: {
    border: "border-warning-border",
    text: "text-warning-foreground",
    tint: "accent-warning-foreground",
  },
  destructive: {
    border: "border-danger-border",
    text: "text-danger-foreground",
    tint: "accent-danger-foreground",
  },
};

const VISIBLE_DOCUMENTS = 3;

/** Disclosure row ids, kept in the feed's expanded-rows state so they survive scrolling away. */
const controlCardRowIds = (messageId: string) => ({
  card: `control:${messageId}`,
  raw: `control-raw:${messageId}`,
  documents: (itemKey: string) => `control-documents:${messageId}:${itemKey}`,
});

export function ControlCardRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly model: ControlCardModel;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly onToggleRow: (rowId: string) => void;
  /** Assistant-style markdown for an excerpt, or the whole message when the card has no items. */
  readonly renderMarkdown: (markdown: string) => ReactNode;
  /** Opens a document a report named, as a link in the message would. */
  readonly onOpenDocument: (path: string) => void;
  readonly iconColor: ColorValue;
}) {
  const { model } = props;
  const ids = controlCardRowIds(props.messageId);
  const expanded = props.expandedRows[ids.card] ?? false;
  const showRaw = props.expandedRows[ids.raw] ?? false;
  const severity = SEVERITY_CLASSES[model.severity];
  // A digest can carry one sub-thread twice: a repeat's key counts its earlier occurrences.
  const seen = new Map<string, number>();
  const items = (model.kind === "card" ? model.items : []).map((entry) => {
    const base = entry.item.threadId ?? entry.item.title;
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    return { entry, key: repeat === 0 ? base : `${base}#${repeat}` };
  });
  const openThreadLink = useOpenThreadLink(props.environmentId);
  const toggle = (rowId: string) => {
    void Haptics.selectionAsync();
    props.onToggleRow(rowId);
  };

  return (
    <View className={cn("mb-2 overflow-hidden rounded-2xl border bg-card", severity.border)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${model.label}: ${model.summary}`}
        accessibilityHint={expanded ? "Hides the detail" : "Shows each excerpt"}
        accessibilityState={{ expanded }}
        className="min-h-11 flex-row items-center gap-1.5 px-3 py-2 active:opacity-70"
        onPress={() => toggle(ids.card)}
      >
        <SymbolView
          name={CHANNEL_SYMBOLS[model.channel]}
          size={13}
          tintColorClassName={severity.tint}
        />
        <Text className={cn("shrink-0 font-t3-medium text-xs", severity.text)}>{model.label}</Text>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-xs">
          {model.summary}
        </Text>
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="down"
          size={11}
          tintColor={props.iconColor}
        />
      </Pressable>

      {items.length > 0 ? (
        items.map(({ entry, key }) => (
          <ControlCardEntry
            key={key}
            environmentId={props.environmentId}
            threadId={props.threadId}
            entry={entry}
            expanded={expanded}
            showAllDocuments={props.expandedRows[ids.documents(key)] ?? false}
            onShowAllDocuments={() => toggle(ids.documents(key))}
            renderMarkdown={props.renderMarkdown}
            onOpenDocument={props.onOpenDocument}
            onOpenThread={(threadId) =>
              openThreadLink(scopeThreadRef(props.environmentId, threadId))
            }
          />
        ))
      ) : expanded ? (
        // A card with no items, and a message whose shape this does not know: the message itself.
        <View className="border-t border-border-subtle px-3 py-2">
          {props.renderMarkdown(props.text)}
        </View>
      ) : null}

      {expanded && items.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showRaw }}
          className="min-h-10 flex-row items-center gap-1.5 border-t border-border-subtle px-3 py-2 active:opacity-70"
          onPress={() => toggle(ids.raw)}
        >
          <ThreadDisclosureChevron
            expanded={showRaw}
            collapsedDirection="right"
            size={10}
            tintColor={props.iconColor}
          />
          <Text className="text-xs text-foreground-muted">
            {showRaw ? "Hide the text the agent received" : "Show the text the agent received"}
          </Text>
        </Pressable>
      ) : null}
      {expanded && showRaw ? (
        <View className="border-t border-border-subtle bg-subtle px-3 py-2">
          {/* The verbatim bytes the model received, never through markdown. */}
          <Text selectable className="font-mono text-2xs leading-4">
            {props.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function ControlCardEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly entry: ControlCardItem;
  readonly expanded: boolean;
  readonly showAllDocuments: boolean;
  readonly onShowAllDocuments: () => void;
  readonly renderMarkdown: (markdown: string) => ReactNode;
  readonly onOpenDocument: (path: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props.entry;
  // Line 2 carries the dispatcher's title, so line 1 is the bare verdict ("Fixed inline").
  const status = item.status?.replaceAll("_", " ");
  const verdict = status ? status.charAt(0).toUpperCase() + status.slice(1) : props.entry.facts;
  const childThreadId = item.threadId;
  // Only this entry's own sub-thread, never the all-threads list: the dispatcher titles items
  // with a generic verdict ("Completed"), so the live title says who reported.
  const sender =
    useThreadShell(
      childThreadId ? { environmentId: props.environmentId, threadId: childThreadId } : null,
    )?.title ?? null;
  const { reportPath } = item;
  const openThread = childThreadId ? () => props.onOpenThread(childThreadId) : null;
  // Reports live outside every project: they open read-only in the file viewer.
  const openReportFile =
    reportPath?.startsWith("/") === true
      ? () => openReport(props.environmentId, props.threadId, reportPath)
      : null;
  const open = openReportFile ?? openThread;
  const detail = [item.role, sender ? item.title : null].filter(Boolean).join(" · ");
  const documents = [...new Set(item.documents ?? [])];
  const visibleDocuments = props.showAllDocuments
    ? documents
    : documents.slice(0, VISIBLE_DOCUMENTS);

  const label = (
    <View className="min-w-0 flex-1 gap-0.5">
      <View className="flex-row items-center gap-1.5">
        {item.icon ? <Text className="text-xs">{item.icon}</Text> : null}
        <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm">
          {sender ?? item.title}
        </Text>
        {verdict ? (
          <Text numberOfLines={1} className="shrink-0 text-xs text-foreground-muted">
            {verdict}
          </Text>
        ) : null}
      </View>
      {detail ? (
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          {detail}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="border-t border-border-subtle px-3 py-1.5">
      <View className="flex-row items-center gap-1">
        {open ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${openReportFile ? "Open report" : "Open thread"}: ${sender ?? item.title}`}
            className="min-h-11 min-w-0 flex-1 flex-row items-center active:opacity-70"
            onPress={() => {
              void Haptics.selectionAsync();
              open();
            }}
          >
            {label}
          </Pressable>
        ) : (
          <View className="min-h-11 min-w-0 flex-1 flex-row items-center">{label}</View>
        )}
        {openThread ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open thread"
            hitSlop={6}
            className="size-9 items-center justify-center rounded-full active:opacity-70"
            onPress={() => {
              void Haptics.selectionAsync();
              openThread();
            }}
          >
            <SymbolView name="arrow.up.right" size={14} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </View>
      {documents.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-1.5 pb-1">
          {visibleDocuments.map((path) => (
            <Chip
              key={path}
              icon="doc.text"
              label={controlDocumentLabel(path)}
              accessibilityLabel={`Open ${path}`}
              onPress={() => props.onOpenDocument(path)}
            />
          ))}
          {documents.length > visibleDocuments.length ? (
            <Chip
              label={`+${documents.length - visibleDocuments.length} more`}
              onPress={props.onShowAllDocuments}
            />
          ) : null}
        </View>
      ) : null}
      {props.expanded && (item.excerpt || item.timestamp) ? (
        <View className="mb-1.5 gap-1 border-l border-border pl-2.5">
          {item.timestamp ? (
            <Text className="text-xs tabular-nums text-foreground-muted">{item.timestamp}</Text>
          ) : null}
          {item.excerpt ? props.renderMarkdown(item.excerpt) : null}
        </View>
      ) : null}
    </View>
  );
}
