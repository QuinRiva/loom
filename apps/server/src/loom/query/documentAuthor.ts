// @effect-diagnostics nodeBuiltinImport:off
/**
 * Who a Query forks: the thread that signed the document. pi's `sign_document` writes a
 * `manager_sessions: [{ id, name, role, authored_at }]` manifest (YAML frontmatter, or an HTML
 * `<!--pi-manifest ... -->` comment) whose `id` is the signing pi session; the provider-thread
 * projection maps that session to its thread. An unsigned document, or one no entry of which
 * resolves, falls back to the viewing thread.
 *
 * @module loom/query/documentAuthor
 */
import * as NodePath from "node:path";

import {
  DOCUMENT_QUERY_ROLE,
  type DocumentQueryAuthorInput,
  type DocumentQueryAuthorSource,
  LOOM_WS_METHODS,
  LoomWsMethodError,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";

/** The `.mdx` preview's read budget: a plan larger than the default 1 MiB still hashes whole. */
const DOCUMENT_READ_MAX_BYTES = 8 * 1024 * 1024;

const ManagerSession = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,}$/)),
  role: Schema.optional(Schema.String),
  authored_at: Schema.optional(Schema.String),
});
type ManagerSession = typeof ManagerSession.Type;
const isManagerSession = Schema.is(ManagerSession);
const decodeManifest = Schema.decodeUnknownOption(
  fromYaml(Schema.Struct({ manager_sessions: Schema.Array(Schema.Unknown) })),
);
const MANIFEST =
  /^(?:---\r?\n([\s\S]*?)\r?\n---|(?:<!DOCTYPE[^>]*>\r?\n)?<!--pi-manifest\r?\n([\s\S]*?)\r?\n-->)/i;

/** The document's well-formed `manager_sessions` entries, in file order. */
export const parseManagerSessions = (contents: string): ReadonlyArray<ManagerSession> => {
  const match = MANIFEST.exec(contents);
  return Option.match(decodeManifest(match?.[1] ?? match?.[2] ?? ""), {
    onNone: () => [],
    onSome: (manifest) => manifest.manager_sessions.filter(isManagerSession),
  });
};

/** Roles that author a document; a `reviewer` or other signer only annotated it. */
const AUTHOR_ROLES = new Set(["plan", "architecture", "intent", "manager"]);

/**
 * Signing sessions in the order to try them: the most recent authoring-role signer first
 * (the pick), then older authoring signers, then any other signer by recency, so a deleted
 * pick still lands on a signer before the viewing thread.
 */
export const signingSessionIds = (entries: ReadonlyArray<ManagerSession>) => [
  ...new Set(
    entries
      .toSorted(
        (left, right) =>
          Number(AUTHOR_ROLES.has(right.role ?? "")) - Number(AUTHOR_ROLES.has(left.role ?? "")) ||
          (right.authored_at ?? "").localeCompare(left.authored_at ?? ""),
      )
      .map((entry) => entry.id),
  ),
];

/**
 * The author a Query on `filePath` from `sourceThreadId` forks, and the document as the
 * viewing thread's workspace holds it now. A query thread stands for its own author, whether
 * it is the viewer or the signer, so a Query never forks a fork.
 *
 * `filePath` is the document as the author names it: a viewer in another worktree opens the
 * author's file by absolute path, which becomes author-relative here so every view keys the
 * same query thread and pins, and the fork (in the author's cwd) can open it.
 */
export const resolveDocumentAuthor = (input: {
  readonly method: string;
  readonly sourceThreadId: ThreadId;
  readonly filePath: string;
}) =>
  Effect.gen(function* () {
    const fail = (message: string, cause?: unknown) =>
      new LoomWsMethodError({ method: input.method, message, cause });
    const orchestrator = yield* OrchestratorV2;
    const store = yield* LoomStoreV2;
    const liveShell = (threadId: ThreadId) =>
      Effect.map(orchestrator.getThreadShell(threadId), (shell) =>
        shell === null || shell.deletedAt != null ? null : shell,
      );
    const authorOf = (threadId: ThreadId) =>
      Effect.flatMap(store.getWorkstream(threadId), (row) =>
        liveShell(
          row?.role === DOCUMENT_QUERY_ROLE && row.forkFromThreadId !== null
            ? row.forkFromThreadId
            : threadId,
        ),
      );
    const projects = yield* ProjectStoreV2;
    const workspaceOf = (shell: { worktreePath: string | null; projectId: ProjectId }) =>
      shell.worktreePath === null
        ? Effect.map(projects.get(shell.projectId), (project) =>
            Option.getOrNull(Option.map(project, (p) => p.workspaceRoot)),
          )
        : Effect.succeed(shell.worktreePath);
    const viewing = yield* liveShell(input.sourceThreadId);
    if (viewing === null) return yield* fail("The source thread was not found.");
    const cwd = yield* workspaceOf(viewing);
    if (cwd === null) return yield* fail("The thread has no workspace to read the document from.");
    const { contents } = yield* (yield* WorkspaceFileSystem)
      .readFile({ cwd, relativePath: input.filePath, maxBytes: DOCUMENT_READ_MAX_BYTES })
      .pipe(Effect.mapError((cause) => fail(`${input.filePath} could not be read.`, cause)));
    const resolved = (
      author: NonNullable<typeof viewing>,
      authorSource: DocumentQueryAuthorSource,
    ) =>
      Effect.map(workspaceOf(author), (root) => {
        const relative =
          root !== null && NodePath.isAbsolute(input.filePath)
            ? NodePath.relative(root, input.filePath)
            : "";
        const inside =
          relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
        return { author, authorSource, contents, filePath: inside ? relative : input.filePath };
      });
    for (const sessionId of signingSessionIds(parseManagerSessions(contents))) {
      const signer = yield* store.threadForPiSession(sessionId);
      const author = signer === null ? null : yield* authorOf(signer);
      if (author !== null) return yield* resolved(author, "signature");
    }
    const author = yield* authorOf(viewing.id);
    if (author === null) return yield* fail("The document's author thread was not found.");
    return yield* resolved(author, "viewing-thread");
  });

/** `loom.documentQueryAuthor`: the Query card's pre-flight, the same resolution `askDocumentQuery` makes. */
export const lookupDocumentQueryAuthor = (input: DocumentQueryAuthorInput) =>
  resolveDocumentAuthor({ method: LOOM_WS_METHODS.documentQueryAuthor, ...input }).pipe(
    Effect.map(({ author, authorSource, filePath }) => ({
      authorThreadId: author.id,
      authorTitle: author.title,
      authorSource,
      filePath,
    })),
    Effect.catchIf(
      (error) => error._tag !== "LoomWsMethodError",
      (cause) =>
        Effect.fail(
          new LoomWsMethodError({
            method: LOOM_WS_METHODS.documentQueryAuthor,
            message: "Could not resolve the document's author.",
            cause,
          }),
        ),
    ),
  );
