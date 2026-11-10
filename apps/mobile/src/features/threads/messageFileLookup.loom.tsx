import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  lookUpUnanchoredFile,
  type UnanchoredLookupResult,
} from "@t3tools/client-runtime/unanchored-file-references";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { Toast } from "../../components/ui/Toast";
import { useBarInset } from "../../components/ui/useBarInset";
import { MOBILE_MOTION } from "../../lib/designTokens";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { basename } from "../files/filePath";
import { messageFileCandidates, type UnanchoredFileLink } from "./messageFileLinks.loom";

/**
 * The shared lookup order run once for a tap: the root, the message's folders, then the index's
 * unique match. A failed stat or index call reads as unverified, never as not found.
 */
export async function lookUpMessageFile(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly link: UnanchoredFileLink;
  readonly markdown: string | undefined;
  readonly signal: AbortSignal;
}): Promise<UnanchoredLookupResult & { readonly rootIsDirectory: boolean }> {
  const options = {
    signal: input.signal,
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  };
  let rootIsDirectory = false;
  const result = await lookUpUnanchoredFile({
    candidates: messageFileCandidates(input.link, input.markdown, input.workspaceRoot),
    reference: input.link.reference,
    stat: async (path) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.fileMetadata({ environmentId: input.environmentId, input: { path } }),
        options,
      );
      if (result._tag !== "Success") return undefined;
      const kind = result.value?.kind;
      if (path === input.link.rootPath && kind === "directory") rootIsDirectory = true;
      return { exists: kind === "file" || kind === "directory", isDirectory: kind === "directory" };
    },
    locate: async (reference) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.locateFiles({
          environmentId: input.environmentId,
          input: { cwd: input.workspaceRoot, references: [reference] },
        }),
        options,
      );
      return result._tag === "Success" ? (result.value.entries[0]?.path ?? null) : undefined;
    },
  });
  return { ...result, rootIsDirectory };
}

type LookupFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" | "not-found"; readonly reference: string };

const IDLE: LookupFeedback = { kind: "idle" };
// A fast answer opens without a flash of feedback; a slow one shows that the tap registered.
const PENDING_DELAY_MS = 300;
const NOT_FOUND_DISMISS_MS = 5_000;

/** Feedback for tap-time lookups, kept out of the feed's own state so it never re-renders rows. */
export function createLinkLookupFeedback() {
  let feedback: LookupFeedback = IDLE;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lookup: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (
    next: LookupFeedback,
    after?: { readonly ms: number; readonly next: LookupFeedback },
  ) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    feedback = next;
    for (const listener of listeners) listener();
    if (after) timer = setTimeout(() => set(after.next), after.ms);
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => feedback,
    /** Shows a busy notice if the lookup outlasts a short delay; an abort clears it. */
    pending: (reference: string, request: AbortController) => {
      lookup = request;
      set(IDLE, { ms: PENDING_DELAY_MS, next: { kind: "pending", reference } });
      request.signal.addEventListener("abort", () => set(IDLE), { once: true });
    },
    /** The way out of a stalled lookup: drop the tap, open nothing. */
    cancel: () => lookup?.abort(),
    settle: () => set(IDLE),
    notFound: (reference: string) =>
      set({ kind: "not-found", reference }, { ms: NOT_FOUND_DISMISS_MS, next: IDLE }),
  };
}

export type LinkLookupFeedback = ReturnType<typeof createLinkLookupFeedback>;

export function useLinkLookupFeedback(): LinkLookupFeedback {
  return useState(createLinkLookupFeedback)[0];
}

export function LinkLookupFeedbackOverlay(props: { readonly feedback: LinkLookupFeedback }) {
  const feedback = useSyncExternalStore(props.feedback.subscribe, props.feedback.get);
  const top = useBarInset() + 8;
  if (feedback.kind === "idle") return null;
  return (
    <Animated.View
      entering={FadeIn.duration(MOBILE_MOTION.enter).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(MOBILE_MOTION.exit).reduceMotion(ReduceMotion.System)}
      className="absolute inset-x-3 z-[100]"
      style={{ top }}
      pointerEvents="box-none"
    >
      {feedback.kind === "pending" ? (
        <Toast
          message={`Looking for ${basename(feedback.reference)}`}
          busy
          onDismiss={props.feedback.cancel}
        />
      ) : (
        <Toast
          message="File not found"
          description={`No file at ${feedback.reference} in this workspace or the folders the message names.`}
          tone="danger"
          onDismiss={props.feedback.settle}
        />
      )}
    </Animated.View>
  );
}
