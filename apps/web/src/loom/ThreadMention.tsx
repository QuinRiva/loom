/**
 * loom: how a `[Title](t3-thread://v1/<id>)` mention reads in chat (rendered by upstream's
 * `MarkdownThreadLink`). Instead of upstream's project favicon, which says nothing when an
 * orchestrator names its own sub-threads, it leads with the target's live state: a static column
 * dot, a check once done, or nothing. Only a thread in another project keeps the favicon.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  attentionReasonsOf,
  type WorkstreamAttentionReason,
} from "@t3tools/client-runtime/state/loom/rollup";
import {
  deriveBoardColumn,
  type WorkstreamBoardColumn,
  workstreamIndexOf,
} from "@t3tools/client-runtime/state/loom/workstream";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { ProjectFavicon, type ProjectFaviconProject } from "../components/ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  ATTENTION_LABELS,
  COLUMN_LABELS,
  isRunning,
  PENDING_REQUEST_LABELS,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import { COLUMN_STYLES } from "../lib/workstreamPresentation";
import { cn } from "../lib/utils";
import { StatusDot } from "./StatusDot";
import { useProject } from "../state/entities";
import { environmentThreadShells } from "../state/threads";

/**
 * What a mention shows: an attention reason, the thread's own pending approval
 * or question, a child's board column, or a live root turn.
 */
export type ThreadMentionStatus =
  | WorkstreamAttentionReason
  | "awaiting_approval"
  | "awaiting_input"
  | WorkstreamBoardColumn
  | "running";

/**
 * The mention's status, or null: a settled outcome wins, then attention, then a workstream child's
 * board column. A root has no plan column (`deriveBoardColumn` would call an unstarted root blocked),
 * so it shows only staging or a running turn. `index` needs only the thread's `blockedBy` siblings.
 */
export function threadMentionStatus(
  thread: OrchestrationV2ThreadShell,
  index: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
): ThreadMentionStatus | null {
  const workstream = thread.workstream;
  if (workstream?.outcome) return workstream.outcome;
  const byId = workstreamIndexOf([
    thread,
    ...(workstream?.blockedBy ?? []).flatMap((id) => index.get(id) ?? []),
  ]);
  const reason = attentionReasonsOf(thread, byId)[0];
  // The thread's own request, not a rollup reason (DL-1270): it outranks all but `error`.
  const request = thread.pendingRuntimeRequest?.kind;
  if (reason !== "error" && request !== undefined && request !== "auth_refresh")
    return request === "user_input" ? "awaiting_input" : "awaiting_approval";
  if (reason !== undefined) return reason;
  if (workstream && workstream.parentThreadId !== null) return deriveBoardColumn(workstream, byId);
  if (workstream?.held) return "held";
  return isRunning({ activity: thread.activityRunStatus ?? null }) ? "running" : null;
}

// Both atoms derive a primitive, so a mention re-renders only when its own dot
// changes, not on every shell update in the environment.
const statusAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const index = get(environmentThreadShells.environmentThreadIndexAtom(ref.environmentId));
    const thread = index.get(ref.threadId);
    return thread === undefined ? null : threadMentionStatus(thread, index);
  }).pipe(Atom.withLabel(`loom-thread-mention-status:${key}`));
});

const projectIdAtom = Atom.family((key: string) =>
  Atom.make(
    (get) => get(environmentThreadShells.threadShellAtom(parseThreadKey(key)))?.projectId ?? null,
  ).pipe(Atom.withLabel(`loom-thread-mention-project:${key}`)),
);

const NULL_ATOM = Atom.make(null);

const ATTENTION_HALO = {
  boxShadow: "0 0 0 2.5px color-mix(in srgb, var(--color-warning) 28%, transparent)",
};

/** A column or a running turn takes the shared state dot; attention keeps its haloed amber. */
const columnStyleOf = (status: ThreadMentionStatus) =>
  status === "running"
    ? COLUMN_STYLES.in_progress
    : Object.hasOwn(COLUMN_STYLES, status)
      ? COLUMN_STYLES[status as keyof typeof COLUMN_STYLES]
      : null;

const STATUS_LABELS = {
  running: "Running",
  ...COLUMN_LABELS,
  ...ATTENTION_LABELS,
  ...PENDING_REQUEST_LABELS,
} satisfies Record<ThreadMentionStatus, string>;

const UNAVAILABLE =
  "Not loaded in this thread list: an older or archived thread, or one in another environment. The label is what the message wrote.";

/**
 * The rendered mention, from resolved facts (the preview renders it directly).
 * An unresolved one is the written label, muted, and still a link: the live
 * index omits older settled and archived threads, but both open.
 */
export function ThreadMentionView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  /** False when this client cannot see the thread. */
  readonly resolved: boolean;
  readonly role: string | null;
  readonly status: ThreadMentionStatus | null;
  /** The target's project, only when it differs from the viewing thread's. */
  readonly otherProject: ProjectFaviconProject | null;
}) {
  const { status, otherProject, role } = props;
  const tooltip = !props.resolved
    ? UNAVAILABLE
    : [
        otherProject?.title,
        status && STATUS_LABELS[status],
        role && role.charAt(0).toUpperCase() + role.slice(1),
      ]
        .filter(Boolean)
        .join(" · ");
  const link = (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.threadId }}
      data-markdown-copy={formatThreadLink(
        { environmentId: null, threadId: props.threadId },
        props.title,
      )}
      className={cn(
        !props.resolved &&
          "cursor-help border-muted-foreground/60 border-b border-dashed text-muted-foreground!",
        // Greyed by colour, not opacity, so the title still clears 4.5:1.
        status === "cancelled" && "text-muted-foreground!",
      )}
    >
      {otherProject ? (
        <span
          className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
          aria-hidden
        >
          <ProjectFavicon project={otherProject} className="size-full" />
        </span>
      ) : status === "done" ? (
        <CheckIcon
          className="ms-[0.2em] me-[0.15em] inline size-[1em] text-success-foreground [vertical-align:-0.125em]"
          aria-hidden
        />
      ) : status ? (
        <span aria-hidden className="ms-[0.3em] me-[0.35em] inline-flex [vertical-align:0.08em]">
          {columnStyleOf(status) ? (
            <StatusDot className="size-[0.5em]" {...columnStyleOf(status)!} />
          ) : (
            <span
              className="inline-block size-[0.5em] rounded-full bg-warning"
              style={ATTENTION_HALO}
            />
          )}
        </span>
      ) : null}
      {props.title}
    </Link>
  );
  if (!tooltip) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** A resolved (or unresolved, `thread` null) mention, written in `fromThreadRef`'s message. */
export function ThreadMention(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly thread: EnvironmentThreadShell | null;
  readonly fromThreadRef: ScopedThreadRef | undefined;
}) {
  const { environmentId, thread } = props;
  const status = useAtomValue(
    thread === null ? NULL_ATOM : statusAtom(threadKey(scopeThreadRef(environmentId, thread.id))),
  );
  const fromProjectId: ProjectId | null = useAtomValue(
    props.fromThreadRef === undefined ? NULL_ATOM : projectIdAtom(threadKey(props.fromThreadRef)),
  );
  // An unknown viewer (a brief card, a file preview) reads as same-project.
  const otherProject = useProject(
    thread !== null && fromProjectId !== null && thread.projectId !== fromProjectId
      ? scopeProjectRef(environmentId, thread.projectId)
      : null,
  );
  return (
    <ThreadMentionView
      environmentId={environmentId}
      threadId={props.threadId}
      title={props.title}
      resolved={thread !== null}
      role={thread?.source.workstream?.role ?? null}
      status={status}
      otherProject={otherProject}
    />
  );
}
