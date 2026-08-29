import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Code2, LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { buildArtifactFrameSrc } from "./artifactView";
import { cn } from "~/lib/utils";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

interface ArtifactViewPanelProps {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  relativePath: string;
  /** Re-mints the signed URL and reloads the iframe whenever it changes. */
  reloadRequestId: number;
  onOpenSource: (relativePath: string) => void;
}

type ArtifactViewState =
  | { status: "minting" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

/**
 * Renders one agent-produced HTML artefact in a sandboxed iframe pointed at the
 * signed asset URL (`GET /api/assets/:token/:file`). Omitting `allow-same-origin`
 * runs the artefact in an opaque origin, so its code cannot reach the app, its
 * RPC, or the session cookie; relative subresources still resolve through the
 * asset route's `baseRelativePath` claim. Available in the web runtime only.
 */
export default function ArtifactViewPanel({
  environmentId,
  threadRef,
  relativePath,
  reloadRequestId,
  onOpenSource,
}: ArtifactViewPanelProps) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const [mintNonce, setMintNonce] = useState(0);
  // Monotonic per-reload token: every reload changes exactly one of the two
  // triggers, so the sum changes on each reload. It cache-busts the iframe
  // `src` and, as the iframe `key`, forces a remount so `onLoad` re-fires.
  const reloadToken = mintNonce + reloadRequestId;
  const [state, setState] = useState<ArtifactViewState>({ status: "minting" });
  const [frameLoaded, setFrameLoaded] = useState(false);

  const reload = useCallback(() => {
    setFrameLoaded(false);
    setMintNonce((nonce) => nonce + 1);
  }, []);

  const threadId = threadRef.threadId;

  // Mint the signed URL for the current file. A reload does NOT rely on this
  // producing a distinct URL (the atom family returns a cached member for the
  // same input); freshness on reload comes from cache-busting the iframe `src`
  // via `reloadToken` below, which also remounts the frame so `onLoad` re-fires.
  useEffect(() => {
    if (!httpBaseUrl) {
      setState({ status: "minting" });
      return;
    }
    let cancelled = false;
    setState({ status: "minting" });
    setFrameLoaded(false);
    void (async () => {
      const result = await createAssetUrl({
        environmentId,
        input: { resource: { _tag: "workspace-file", threadId, path: relativePath } },
      });
      if (cancelled) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load this artefact.",
        });
        return;
      }
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (url === null) {
        setState({ status: "error", message: "The environment returned an invalid asset URL." });
        return;
      }
      setState({ status: "ready", url });
    })();
    return () => {
      cancelled = true;
    };
    // `mintNonce` (Reload/Retry) and `reloadRequestId` (chip re-click) both force
    // a re-mint; the rest are the identity of what is being minted.
  }, [
    createAssetUrl,
    environmentId,
    httpBaseUrl,
    relativePath,
    threadId,
    reloadRequestId,
    mintNonce,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="surface-subheader gap-2 px-3" data-surface-subheader>
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" />
            }
          >
            {relativePath}
          </TooltipTrigger>
          <TooltipPopup>{relativePath}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={false}
                onPressedChange={reload}
                aria-label="Reload artefact"
                variant="ghost"
                size="sm"
              >
                <RotateCw className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup>Reload artefact</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={false}
                onPressedChange={() => onOpenSource(relativePath)}
                aria-label="Open source"
                variant="ghost"
                size="sm"
              >
                <Code2 className="size-3.5" />
              </Toggle>
            }
          />
          <TooltipPopup>Open source</TooltipPopup>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.status === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-xs leading-relaxed text-destructive">{state.message}</p>
            <button
              type="button"
              onClick={reload}
              className={cn(
                "rounded-md border border-border/80 px-3 py-1.5 text-xs font-medium",
                "text-foreground transition hover:border-border hover:bg-accent/60",
              )}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {state.status === "ready" ? (
              <iframe
                key={buildArtifactFrameSrc(state.url, reloadToken)}
                src={buildArtifactFrameSrc(state.url, reloadToken)}
                sandbox="allow-scripts allow-forms allow-modals"
                referrerPolicy="no-referrer"
                title={relativePath}
                className="absolute inset-0 size-full border-0 bg-white"
                onLoad={() => setFrameLoaded(true)}
              />
            ) : null}
            {state.status === "minting" || !frameLoaded ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
