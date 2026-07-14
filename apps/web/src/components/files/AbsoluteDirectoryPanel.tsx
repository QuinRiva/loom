import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRight, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

import { useProjectAbsoluteDirectoryQuery } from "./projectFilesQueryState";

interface AbsoluteDirectoryPanelProps {
  environmentId: EnvironmentId;
  /** The absolute directory the surface is rooted at; navigation never escapes it. */
  rootPath: string;
  threadRef: ScopedThreadRef;
}

/** POSIX-only join used for deriving child paths within an absolute root. */
function posixJoin(base: string, segment: string): string {
  return `${base.replace(/\/+$/, "")}/${segment}`;
}

/** Segments of `path` below `root` (empty when at the root). */
function relativeSegments(root: string, path: string): string[] {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (path === normalizedRoot) return [];
  const suffix = path.startsWith(`${normalizedRoot}/`) ? path.slice(normalizedRoot.length + 1) : "";
  return suffix.split("/").filter((segment) => segment.length > 0);
}

function rootLabel(root: string): string {
  const segments = root.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments.at(-1) ?? root;
}

export default function AbsoluteDirectoryPanel({
  environmentId,
  rootPath,
  threadRef,
}: AbsoluteDirectoryPanelProps) {
  const { resolvedTheme } = useTheme();
  const normalizedRoot = useMemo(() => rootPath.replace(/\/+$/, "") || rootPath, [rootPath]);
  const [currentPath, setCurrentPath] = useState(normalizedRoot);

  // Reset navigation to the root whenever the surface is re-pointed at a
  // different absolute directory.
  useEffect(() => {
    setCurrentPath(normalizedRoot);
  }, [normalizedRoot]);

  const directory = useProjectAbsoluteDirectoryQuery(environmentId, currentPath);
  const segments = useMemo(
    () => relativeSegments(normalizedRoot, currentPath),
    [normalizedRoot, currentPath],
  );

  const navigateToDepth = useCallback(
    (depth: number) => {
      setCurrentPath(
        depth <= 0 ? normalizedRoot : posixJoin(normalizedRoot, segments.slice(0, depth).join("/")),
      );
    },
    [normalizedRoot, segments],
  );

  const openEntry = useCallback(
    (name: string, kind: "file" | "directory") => {
      const childPath = posixJoin(currentPath, name);
      if (kind === "directory") {
        setCurrentPath(childPath);
        return;
      }
      useRightPanelStore.getState().openFileAbsolute(threadRef, childPath);
    },
    [currentPath, threadRef],
  );

  const entries = directory.data?.entries ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-absolute-directory-panel>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {rootLabel(normalizedRoot)}
          </div>
          <div className="truncate text-[10px] leading-none text-amber-600 dark:text-amber-400">
            Outside workspace · read-only
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh directory listing"
          onClick={directory.refresh}
        >
          <RefreshCw className={cn("size-3.5", directory.isPending && "animate-spin")} />
        </button>
      </div>
      {/* Plain overflow-x row: a ScrollArea's full-size viewport would overlay
          and intercept pointer events on the entry list below it. */}
      <div className="flex h-7 shrink-0 items-center overflow-x-auto border-b border-border/60 px-3 text-[11px]">
        <button
          type="button"
          className={cn(
            "max-w-40 shrink-0 truncate rounded px-1 py-0.5 hover:bg-accent",
            segments.length === 0 ? "font-medium text-foreground" : "text-muted-foreground",
          )}
          title={normalizedRoot}
          onClick={() => navigateToDepth(0)}
        >
          {rootLabel(normalizedRoot)}
        </button>
        {segments.map((segment, index) => (
          <div
            key={segments.slice(0, index + 1).join("/")}
            className="flex min-w-0 shrink-0 items-center"
          >
            <ChevronRight className="mx-0.5 size-3 shrink-0 text-muted-foreground/60" />
            <button
              type="button"
              className={cn(
                "max-w-40 truncate rounded px-1 py-0.5 hover:bg-accent",
                index === segments.length - 1
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => navigateToDepth(index + 1)}
            >
              {segment}
            </button>
          </div>
        ))}
      </div>
      {directory.error && directory.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{directory.error}</div>
      ) : directory.data === null && directory.isPending ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">This directory is empty.</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="py-1">
            {entries.map((entry) => (
              <li key={`${entry.kind}:${entry.name}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-foreground hover:bg-accent"
                  onClick={() => openEntry(entry.name, entry.kind)}
                >
                  <PierreEntryIcon
                    pathValue={entry.name}
                    kind={entry.kind}
                    theme={resolvedTheme}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
