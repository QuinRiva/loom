/**
 * loom: centre-panel thread tab strip.
 *
 * Renders the open-tab set (from `threadTabsStore`) as a horizontal, drag-
 * reorderable strip above `ChatView`, mirroring `RightPanelTabs`' interaction
 * vocabulary (hover-reveal close, middle-click close, context menu, overflow
 * scroll with edge fade + active `scrollIntoView`). Tab order is the user's
 * working set, so unlike the right panel the strip is dnd-kit sortable.
 *
 * Active-tab highlight follows the URL-active thread (`activeRouteRef`), not the
 * store's `activeKey`, so the index/draft routes show the strip with no tab
 * highlighted.
 */
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToFirstScrollableAncestor } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef } from "react";

import { resolveThreadStatusPill } from "~/components/Sidebar.logic";
import { ThreadStatusLabel } from "~/components/ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useUiStateStore } from "~/uiStateStore";
import { X } from "lucide-react";

import { useThreadTabsStore } from "./threadTabsStore";
import { useThreadTabActions } from "./useThreadTabsSync";

type TabContextMenuAction = "copy-link" | "close" | "close-others" | "close-to-right" | "close-all";

interface TabModel {
  ref: ScopedThreadRef;
  key: string;
  title: string;
  isPreview: boolean;
  isActive: boolean;
  isUnavailable: boolean;
  environmentLabel: string | null;
  status: ReturnType<typeof resolveThreadStatusPill>;
}

export function ThreadTabsStrip({ activeRouteRef }: { activeRouteRef: ScopedThreadRef | null }) {
  const tabs = useThreadTabsStore((state) => state.tabs);
  const previewKey = useThreadTabsStore((state) => state.previewKey);
  const shells = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const lastVisitedById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const actions = useThreadTabActions(activeRouteRef);
  const reorderTab = useThreadTabsStore((state) => state.reorderTab);

  const tabListRef = useRef<HTMLDivElement>(null);
  const activeRouteKey = activeRouteRef ? scopedThreadKey(activeRouteRef) : null;

  const shellByKey = useMemo(() => {
    const map = new Map<string, (typeof shells)[number]>();
    for (const shell of shells) {
      map.set(scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }), shell);
    }
    return map;
  }, [shells]);

  const environmentLabelById = useMemo(() => {
    const map = new Map<EnvironmentId, string>();
    for (const environment of environments) {
      map.set(environment.environmentId, environment.label);
    }
    return map;
  }, [environments]);

  const models = useMemo<TabModel[]>(() => {
    return tabs.map((ref) => {
      const key = scopedThreadKey(ref);
      const shell = shellByKey.get(key) ?? null;
      const isRemote = primaryEnvironmentId !== null && ref.environmentId !== primaryEnvironmentId;
      const lastVisitedAt = lastVisitedById[key];
      return {
        ref,
        key,
        title: shell?.title ?? ref.threadId,
        isPreview: previewKey === key,
        isActive: activeRouteKey === key,
        isUnavailable: shell === null,
        environmentLabel: isRemote
          ? (environmentLabelById.get(ref.environmentId) ?? "Remote")
          : null,
        status: shell
          ? resolveThreadStatusPill({
              thread: {
                ...shell,
                ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
              },
            })
          : null,
      };
    });
  }, [
    tabs,
    shellByKey,
    previewKey,
    activeRouteKey,
    primaryEnvironmentId,
    environmentLabelById,
    lastVisitedById,
  ]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeRef = tabs.find((ref) => scopedThreadKey(ref) === active.id);
      const overIndex = tabs.findIndex((ref) => scopedThreadKey(ref) === over.id);
      if (!activeRef || overIndex < 0) return;
      reorderTab(activeRef, overIndex);
    },
    [reorderTab, tabs],
  );

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent, model: TabModel) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      const index = tabs.findIndex((ref) => scopedThreadKey(ref) === model.key);
      if (index < 0) return;
      const items: ContextMenuItem<TabContextMenuAction>[] = [
        { id: "copy-link", label: "Copy link" },
        { id: "close", label: "Close" },
        { id: "close-others", label: "Close others", disabled: tabs.length <= 1 },
        { id: "close-to-right", label: "Close to the right", disabled: index >= tabs.length - 1 },
        { id: "close-all", label: "Close all", disabled: tabs.length === 0 },
      ];
      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-link":
          void navigator.clipboard?.writeText(threadUrl(model.ref));
          break;
        case "close":
          actions.closeTab(model.ref);
          break;
        case "close-others":
          actions.closeOthers(model.ref);
          break;
        case "close-to-right":
          actions.closeToRight(model.ref);
          break;
        case "close-all":
          actions.closeAll();
          break;
        case null:
          break;
      }
    },
    [actions, tabs],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeRouteKey]);

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
      data-thread-tab-strip
    >
      <ScrollArea
        ref={tabListRef}
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1 rounded-none"
      >
        <div className="flex h-full w-max min-w-full items-center gap-1">
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={models.map((model) => model.key)}
              strategy={horizontalListSortingStrategy}
            >
              {models.map((model) => (
                <ThreadTab
                  key={model.key}
                  model={model}
                  onActivate={() => actions.activateTab(model.ref)}
                  onClose={() => actions.closeTab(model.ref)}
                  onContextMenu={(event) => void handleContextMenu(event, model)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </ScrollArea>
    </div>
  );
}

function threadUrl(ref: ScopedThreadRef): string {
  const params = buildThreadRouteParams(ref);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/${params.environmentId}/${params.threadId}`;
}

function ThreadTab({
  model,
  onActivate,
  onClose,
  onContextMenu,
}: {
  model: TabModel;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: model.key,
  });

  const handleMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button === 1) event.preventDefault();
  }, []);
  const handleAuxClick = useCallback(
    (event: ReactMouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    },
    [onClose],
  );

  const label = model.environmentLabel ? `${model.title} · ${model.environmentLabel}` : model.title;

  return (
    <div
      ref={setNodeRef}
      data-active-tab={model.isActive}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      onContextMenu={onContextMenu}
      className={cn(
        "group flex h-7 min-w-25 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
        isDragging && "z-20 opacity-80",
        model.isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        model.isUnavailable && "opacity-50",
      )}
      {...attributes}
      {...listeners}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onClick={onActivate}
            >
              {model.status ? <ThreadStatusLabel status={model.status} compact /> : null}
              <span className={cn("truncate", model.isPreview && "italic")}>{label}</span>
            </button>
          }
        />
        <TooltipPopup>
          {model.isUnavailable ? `${label} — thread unavailable on this connection` : label}
        </TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className="relative flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
        aria-label={`Close ${model.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
