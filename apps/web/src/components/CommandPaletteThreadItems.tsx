import { scopeThreadRef } from "@t3tools/client-runtime/environment"; // loom: find moved to openThreadSearchTarget
import {
  claimThreadOpen,
  nextShownOrder,
  type EnvironmentThreadSearchMatch,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
import {
  foldSearchQuery,
  PALETTE_MESSAGE_LIMIT,
  pickedQuery,
  rankMessageMatches,
} from "@t3tools/shared/paletteSearch";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";
import { useGT, useMessages } from "gt-react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useDelegatedUnderParent, useVisibleThreadShells } from "../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useThreadSearch } from "../state/queries";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  buildThreadActionItems,
  type CommandPaletteActionItem, // loom
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { useEnvironmentLookups, useProjectLookups } from "./CommandPaletteLookups";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";
import { CacheFuelRing } from "../loom/CacheFuelRing"; // loom: prompt-cache liveness
import { ArchivedBadge } from "../loom/ArchivedSearchResultRow"; // loom: archived roots
// loom: search switches, sub-thread rows, and rows that open the thread their excerpt is from
import {
  threadSearchShowsExcerpt,
  threadSearchTarget,
  type ThreadSearchFilters,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import { openThreadSearchTarget, type useThreadSearchSwitches } from "../loom/threadSearchSwitches";

function useProviderEntryByEnvironmentAndInstanceId() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const serverConfig = environment.serverConfig;
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
}

function useConnectedThreadSearch(query: string, filters: ThreadSearchFilters /* loom */) {
  const { environments } = useEnvironments();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const environmentIds: ReadonlyArray<EnvironmentId> = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  // The palette matches environment names when there are several; older rows must match the same.
  const environmentLabels =
    environments.length > 1
      ? Object.fromEntries(
          environmentIds.flatMap((environmentId) => {
            const label = projectEnvironmentLocationById.get(environmentId)?.label;
            return label === undefined || label === null ? [] : [[environmentId, label]];
          }),
        )
      : undefined;
  return useThreadSearch(environmentIds, query, {
    ...filters, // loom: switches
    ...(environmentLabels === undefined ? {} : { environmentLabels }),
  });
}

/**
 * Every visible thread as a palette item, plus, for a non-empty
 * `threadSearchQuery`, the threads whose messages match, best first.
 */
export function useCommandPaletteThreadItems(input: {
  readonly activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null;
  readonly threadSearchQuery: string;
  readonly searchSwitches: ReturnType<typeof useThreadSearchSwitches>; // loom
}) {
  const { activeThread, threadSearchQuery, searchSwitches } = input; // loom: searchSwitches
  const messages = useMessages();
  const gt = useGT();
  const navigate = useNavigate();
  const threads = useVisibleThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const providerEntryByEnvironmentAndInstanceId = useProviderEntryByEnvironmentAndInstanceId();
  const messageSearch = useConnectedThreadSearch(threadSearchQuery, searchSwitches.filters); // loom
  const { projectByKey } = useProjectLookups();
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  // Ranking is relative to when the palette opened, so rows do not reorder as time passes.
  const [now] = useState(() => Date.now());

  // loom: `to`, the thread a search row opens (a report's sub-thread); the pick stays this thread's
  const runThread = async (
    thread: (typeof threads)[number],
    to = scopeThreadRef(thread.environmentId, thread.id),
  ) => {
    // A pick sends its open with the query, always, so the server records
    // it; the thread view then skips its own open. The open thread is no pick.
    const isOpen =
      activeThread?.environmentId === thread.environmentId && activeThread.id === thread.id;
    if (threadSearchQuery.trim().length > 0 && !threadSearchQuery.startsWith(">") && !isOpen) {
      // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
      claimThreadOpen(thread.environmentId, thread.id, Date.now());
    }
    if (
      threadSearchQuery.trim().length > 0 &&
      !threadSearchQuery.startsWith(">") &&
      thread.lastVisitedAt !== undefined &&
      !isOpen
    ) {
      void visitThread({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          visitedAt: thread.updatedAt,
          opened: true,
          searchQuery: pickedQuery(threadSearchQuery),
        },
      });
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(to),
    });
  };

  const { environments } = useEnvironments();
  const projectIds = searchSwitches.filters.projectIds; // loom: the project chip narrows titles too
  const threadItems = buildThreadActionItems(
    {
      threads:
        projectIds === undefined // loom: project chip
          ? threads
          : threads.filter((thread) => projectIds.includes(thread.projectId)),
      delegatedUnderParent,
      ...(environments.length > 1
        ? {
            environmentLabelOf: (thread: (typeof threads)[number]) =>
              projectEnvironmentLocationById.get(thread.environmentId)?.label ?? null,
          }
        : {}),
      ...(activeThread ? { activeThread } : {}),
      projectByKey,
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      renderLeadingContent: (thread) => (
        <>
          <CacheFuelRing thread={thread} /> {/* loom: prompt-cache fuel ring */}
          <ThreadRowLeadingStatus thread={thread} />
        </>
      ),
      renderTrailingContent: (thread) => (
        <>
          <ThreadSearchPullRequestNumber
            thread={thread}
            query={threadSearchQuery}
            settled={thread.settledOverride === "settled"}
          />
          <ThreadRowTrailingStatus thread={thread} />
        </>
      ),
      renderDescription: (thread, { projectTitle }) => {
        const modelInstanceId =
          thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
        const providerEntry =
          providerEntryByEnvironmentAndInstanceId.get(
            `${thread.environmentId}:${modelInstanceId}`,
          ) ?? null;
        return (
          <ThreadCommandSubtitle
            project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
            projectTitle={projectTitle ?? null}
            environmentLabel={
              projectEnvironmentLocationById.get(thread.environmentId)?.label ??
              gt("Remote", { $context: "machine location" })
            }
            branch={thread.branch}
            worktreePath={thread.worktreePath}
            isCurrent={
              thread.id === activeThread?.id && thread.environmentId === activeThread.environmentId
            }
            driverKind={providerEntry?.driverKind ?? null}
            providerDisplayName={
              thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
            }
            acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
            acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
          />
        );
      },
      runThread, // loom: hoisted, so a search row can record its pick and open another thread
    },
    messages,
  );

  // loom: an archived root has no shell, so its row is built from the match; it ranks with
  // the listed threads by title and, failing that, in the messages section.
  const archivedThreadItems = messageSearch.matches.flatMap((match): CommandPaletteActionItem[] => {
    if (match.archivedAt === null) return [];
    const projectTitle = projectByKey.get(`${match.environmentId}:${match.projectId}`)?.title;
    return [
      {
        kind: "action",
        value: `thread:${match.environmentId}:${match.threadId}`,
        searchTerms: [match.title],
        threadSearch: {
          id: match.threadId,
          title: match.title,
          projectTitle: projectTitle ?? null,
          activityAt: Date.parse(match.updatedAt),
        },
        title: match.title || gt("Untitled thread"),
        ...(projectTitle ? { description: projectTitle } : {}),
        timestamp: formatRelativeTimeLabel(match.updatedAt),
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        titleTrailingContent: <ArchivedBadge />,
        run: async () => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(match.environmentId, match.threadId)),
          });
        },
      },
    ];
  });
  const itemByValue = new Map(
    [...threadItems, ...archivedThreadItems].map((item) => [item.value, item]), // loom
  );
  const itemForMatch = (match: EnvironmentThreadSearchMatch) =>
    itemByValue.get(`thread:${match.environmentId}:${match.threadId}`);
  const rankedMessageItems = rankMessageMatches(
    messageSearch.matches,
    (match) => itemForMatch(match)?.threadSearch,
    foldSearchQuery(threadSearchQuery),
    now,
    { withoutTitleMatches: true },
  ).flatMap((match) => {
    const item = itemForMatch(match);
    if (!item) return [];
    // loom: a heading over its sub-thread rows keeps its project line and draws no excerpt
    if (!threadSearchShowsExcerpt(match)) return [item];
    // The snippet replaces the project line, so a message row is as tall as a title row.
    const { description: _description, ...rest } = item;
    return [
      {
        ...rest,
        // When the matching message was written, not when the thread last moved.
        ...(match.messageCreatedAt
          ? { timestamp: formatRelativeTimeLabel(match.messageCreatedAt, undefined, messages) }
          : {}),
        threadContentMatch: {
          source: match.source,
          snippet: match.snippet,
          query: messageSearch.query,
          matchedThreadId: match.matchedThreadId, // loom
          matchedThreadTitle: match.matchedThreadTitle, // loom
        },
        // Opens the thread with find on the word at the matched message, so it is in view.
        // loom: or the sub-thread a report or sub-thread excerpt is from, with its report beside it.
        run: async () => {
          const target = threadSearchTarget(match);
          const thread = threads.find(
            (candidate) =>
              candidate.environmentId === match.environmentId && candidate.id === match.threadId,
          );
          await openThreadSearchTarget(target, messageSearch.query, (to) =>
            target.threadId === match.threadId
              ? item.run()
              : thread
                ? runThread(thread, to)
                : navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(to) }),
          );
        },
      },
    ];
  });

  // Rows already shown keep their places when a slower environment answers.
  const [shownOrder, setShownOrder] = useState<ShownOrder | null>(null);
  const order = nextShownOrder(
    shownOrder,
    messageSearch.key, // loom: a flipped switch starts a fresh order
    rankedMessageItems.map((item) => item.value),
    PALETTE_MESSAGE_LIMIT,
  );
  if (order !== shownOrder) setShownOrder(order);
  const messageItemByValue = new Map(rankedMessageItems.map((item) => [item.value, item]));
  const threadMessageItems = order.keys
    .slice(0, order.shown)
    .flatMap((value) => messageItemByValue.get(value) ?? []);

  return {
    threadItems: [...threadItems, ...archivedThreadItems], // loom: + archived roots
    threadMessageItems,
    now,
    isSearchPending: messageSearch.isPending,
    isSearchFailed: messageSearch.failed,
    threadSubRows: searchSwitches.subRows(messageSearch.matches), // loom: sub-thread rows
  };
}
