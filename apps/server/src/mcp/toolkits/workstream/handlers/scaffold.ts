/**
 * `workstream_scaffold`: a whole child graph in one `thread.scaffold`, all or
 * nothing. References are a node key (this call's, or an existing child's
 * graph key) or `thread:<id>`; a fork node inherits its source's identity along
 * the fork chain. Nodes are created unbriefed, so none starts before
 * `workstream_brief`. The arm validates the graph (live siblings, cycles,
 * unique and non-UUID keys) under the caller's lock; its refusal names nodes
 * by key.
 *
 * @module mcp/toolkits/workstream/handlers/scaffold
 */
import {
  GoalTaskId,
  type LoomScaffoldNode,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import { agentToolName as t } from "../families.ts";
import { LoomToolError, type LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId, stableThreadId } from "../idempotency.ts";
import { resolveChildModel, withUpstreamOptionIds } from "../modelSelection.ts";
import { appendWarnings } from "../render.ts";
import { anchorError, gateRoutes, nodeShapeError, trimmed, withImpliedEdges } from "./childNode.ts";
import {
  childrenOf,
  dispatch,
  fail,
  nowIso,
  requireShell,
  SCAFFOLD_THREAD_REF_PREFIX,
  stripThreadRef,
} from "./shared.ts";

const NOTHING = "Nothing was created.";
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Identity {
  readonly role: string | null;
  readonly modelSelection: ModelSelection;
  readonly anchorTaskId: GoalTaskId | null;
}

export const workstreamScaffold = Effect.fn("LoomToolkit.workstreamScaffold")(function* (
  input: LoomToolInput<"workstream_scaffold">,
  caller: WorkstreamCaller,
) {
  if (input.nodes.length === 0)
    return yield* fail("nodes must be a non-empty array of scaffold node objects.");
  const reject = (key: string, message: string) => fail(`node "${key}": ${message}`);
  for (const node of input.nodes) {
    if (UUID_SHAPED.test(node.key.trim()))
      return yield* reject(
        node.key,
        `the key is UUID-shaped; keys must be symbolic (reference an existing thread with the "${SCAFFOLD_THREAD_REF_PREFIX}" prefix instead). ${NOTHING}`,
      );
    const shapeError = nodeShapeError(node, NOTHING);
    if (shapeError !== undefined) return yield* reject(node.key, shapeError);
  }

  const parent = yield* requireShell(caller.threadId);
  const parentRow = yield* authoriseTarget(caller);
  const live = (yield* childrenOf(caller.threadId)).filter((child) => child.archivedAt === null);
  const requestId = yield* requestKey(input.clientRequestId);
  const nodes = input.nodes.map((node, index) => ({
    ...node,
    key: node.key.trim(),
    threadId: stableThreadId(caller, requestId, "workstream-scaffold", index),
  }));
  const keyToId = new Map<string, ThreadId>([
    ...live.flatMap((child) =>
      child.graphKey === null ? [] : [[child.graphKey, child.threadId] as const],
    ),
    ...nodes.map((node) => [node.key, node.threadId] as const),
  ]);
  const liveIds = new Set(live.map((child) => child.threadId));
  const resolveRef = (key: string, field: string, ref: string) => {
    const text = ref.trim();
    if (text.startsWith(SCAFFOLD_THREAD_REF_PREFIX)) {
      const id = stripThreadRef(text);
      return liveIds.has(id)
        ? Effect.succeed(id)
        : reject(
            key,
            `${field} "${ref}" does not name an active existing child of this parent. ${NOTHING}`,
          );
    }
    if (UUID_SHAPED.test(text))
      return reject(
        key,
        `${field} "${ref}" is UUID-shaped but unprefixed — reference an existing thread with the "${SCAFFOLD_THREAD_REF_PREFIX}" prefix, or use a symbolic key. ${NOTHING}`,
      );
    const id = keyToId.get(text);
    return id === undefined
      ? reject(
          key,
          `${field} "${ref}" is neither a node key in this scaffold nor an existing child's key. ${NOTHING}`,
        )
      : Effect.succeed(id);
  };

  const resolved = yield* Effect.forEach(nodes, (node) =>
    Effect.gen(function* () {
      const forkFrom =
        node.forkFrom === undefined
          ? undefined
          : yield* resolveRef(node.key, "forkFrom", node.forkFrom);
      if (forkFrom === node.threadId)
        return yield* reject(node.key, `forkFrom cannot name the node itself. ${NOTHING}`);
      const gateRework =
        node.gate === undefined
          ? undefined
          : yield* resolveRef(node.key, "gate.rework", node.gate.rework);
      const edges = withImpliedEdges({
        blockedBy: yield* Effect.forEach(node.blockedBy ?? [], (ref) =>
          resolveRef(node.key, "blockedBy", ref),
        ),
        gateRework,
        forkFrom,
      });
      return { node, forkFrom, gateRework, edges };
    }),
  );

  const anchorRejection = yield* anchorError(
    parentRow,
    nodes.flatMap((node) => (node.anchorTaskId === undefined ? [] : [node.anchorTaskId])),
    NOTHING,
  );
  if (anchorRejection !== undefined) return yield* fail(anchorRejection);

  // Identities: an existing child's (a fork source), each non-fork node's own,
  // then each fork node's source's along its chain.
  const identities = new Map<ThreadId, Identity>();
  for (const child of live.filter((candidate) =>
    resolved.some((entry) => entry.forkFrom === candidate.threadId),
  )) {
    identities.set(child.threadId, {
      role: child.role,
      modelSelection: withUpstreamOptionIds((yield* requireShell(child.threadId)).modelSelection),
      anchorTaskId: child.anchorTaskId,
    });
  }
  const modelWarnings: Array<string> = [];
  for (const { node } of resolved.filter((entry) => entry.forkFrom === undefined)) {
    const model = yield* resolveChildModel({
      role: trimmed(node.role)!,
      modelSelection: node.modelSelection,
      modelPreset: node.modelPreset,
      taskShape: node.taskShape,
      sensitive: node.sensitive,
      parentSelection: parent.modelSelection,
    }).pipe(
      Effect.mapError(
        (error) => new LoomToolError({ message: `node "${node.key}": ${error.message}` }),
      ),
    );
    modelWarnings.push(...model.warnings.map((warning) => `[${node.key}] ${warning}`));
    identities.set(node.threadId, {
      role: trimmed(node.role)!,
      modelSelection: model.selection,
      anchorTaskId: node.anchorTaskId === undefined ? null : GoalTaskId.make(node.anchorTaskId),
    });
  }
  const forkSourceOf = new Map(resolved.map((entry) => [entry.node.threadId, entry.forkFrom]));
  const identityOf = (id: ThreadId, seen: ReadonlySet<ThreadId>): Identity | null => {
    const known = identities.get(id);
    if (known !== undefined) return known;
    const source = forkSourceOf.get(id);
    return source === undefined || seen.has(id) ? null : identityOf(source, new Set([...seen, id]));
  };

  const commandNodes: Array<LoomScaffoldNode> = [];
  for (const { node, forkFrom, gateRework, edges } of resolved) {
    const identity = identityOf(node.threadId, new Set());
    if (identity === null)
      return yield* reject(
        node.key,
        `forkFrom forms a cycle; a fork chain must end at a node or child that is not a fork. ${NOTHING}`,
      );
    commandNodes.push({
      threadId: node.threadId,
      graphKey: node.key,
      role: identity.role,
      title: trimmed(node.title)!,
      purpose: trimmed(node.purpose)!,
      blockedBy: edges.blockedBy,
      ...(gateRework === undefined ? {} : { routes: gateRoutes(gateRework, node.gate?.maxRounds) }),
      spawnGeneration: parent.activeRunId ?? requestId,
      ...(forkFrom === undefined ? {} : { forkFromThreadId: forkFrom }),
      // Explicit, else inherited along the fork chain.
      anchorTaskId:
        node.anchorTaskId === undefined
          ? identity.anchorTaskId
          : GoalTaskId.make(node.anchorTaskId),
      modelSelection: identity.modelSelection,
    });
  }

  const keyOf = new Map(nodes.map((node) => [node.threadId as string, node.key]));
  yield* dispatch({
    type: "thread.scaffold",
    commandId: stableCommandId(caller, requestId, "workstream-scaffold"),
    threadId: caller.threadId,
    createdAt: yield* nowIso,
    nodes: commandNodes,
  }).pipe(
    Effect.mapError(
      (error) =>
        new LoomToolError({
          message: `${[...keyOf].reduce(
            (text, [id, key]) => text.replaceAll(id, `node "${key}"`),
            error.message,
          )} ${NOTHING}`,
        }),
    ),
  );
  return appendWarnings(
    `Scaffolded ${nodes.length} Workstream node(s): ${nodes
      .map((node) => `${node.key} → ${node.threadId}`)
      .join(", ")}. Each awaits a brief (${t("workstream_brief")}) before it can launch.`,
    [
      ...modelWarnings,
      ...resolved.flatMap(({ node, edges }) =>
        edges.warnings.map((warning) => `[${node.key}] ${warning}`),
      ),
    ],
  );
});
