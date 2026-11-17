// @effect-diagnostics nodeBuiltinImport:off
/**
 * Who a Query forks: the thread that signed the document. `sign_document`'s `manager_sessions`
 * manifest (YAML frontmatter or `<!--pi-manifest -->`) names the signing pi session, which the
 * provider-thread projection maps to its thread; otherwise the viewing thread.
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
const AUTHOR_ROLES = new Set(["plan", "recap", "explainer", "architecture", "intent", "manager"]);

const isAuthoring = (entry: ManagerSession) => AUTHOR_ROLES.has(entry.role ?? "");

/**
 * Signing sessions in the order to try them, one entry per session: the most recent
 * authoring-role signer first (the pick), then older authoring signers, then any other signer by
 * recency, so a deleted pick still lands on a signer before the viewing thread.
 */
export const signingSessions = (entries: ReadonlyArray<ManagerSession>) =>
  entries
    .toSorted(
      (left, right) =>
        Number(isAuthoring(right)) - Number(isAuthoring(left)) ||
        (right.authored_at ?? "").localeCompare(left.authored_at ?? ""),
    )
    .filter((entry, index, sorted) => sorted.findIndex((e) => e.id === entry.id) === index);

/**
 * The author a Query on `filePath` from `sourceThreadId` forks (a query thread stands for its
 * own author, so a Query never forks a fork), and the document as the viewer holds it. An
 * absolute path from another worktree becomes author-relative, so every view keys the same
 * query thread and pins and the fork can open it.
 */
export const resolveDocumentAuthor = Effect.fn("documentAuthor.resolveDocumentAuthor")(
  function* (input: {
    readonly method: string;
    readonly sourceThreadId: ThreadId;
    readonly filePath: string;
  }) {
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
    const absolutePath = NodePath.resolve(cwd, input.filePath);
    const resolved = (
      author: NonNullable<typeof viewing>,
      authorSource: DocumentQueryAuthorSource,
      signature: ManagerSession | null,
    ) =>
      Effect.map(workspaceOf(author), (root) => {
        const relative =
          root !== null && NodePath.isAbsolute(input.filePath)
            ? NodePath.relative(root, input.filePath)
            : "";
        const inside =
          relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
        const filePath = inside ? relative : input.filePath;
        return {
          author,
          authorSource,
          signature,
          contents,
          filePath,
          absolutePath,
          sameFile: root !== null && NodePath.resolve(root, filePath) === absolutePath,
        };
      });
    for (const signature of signingSessions(parseManagerSessions(contents))) {
      const signer = yield* store.threadForPiSession(signature.id);
      const author = signer === null ? null : yield* authorOf(signer);
      if (author !== null) return yield* resolved(author, "signature", signature);
    }
    const author = yield* authorOf(viewing.id);
    if (author === null) return yield* fail("The document's author thread was not found.");
    return yield* resolved(author, "viewing-thread", null);
  },
);

/**
 * `loom.documentQueryAuthor`: the same resolution `askDocumentQuery` makes, read by the Query
 * card, the document header and the link follow, plus the threads in the author's workstream
 * that edited the file after the signature.
 */
export const lookupDocumentQueryAuthor = (input: DocumentQueryAuthorInput) =>
  resolveDocumentAuthor({ method: LOOM_WS_METHODS.documentQueryAuthor, ...input }).pipe(
    Effect.flatMap(({ author, authorSource, signature, filePath, absolutePath, sameFile }) =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const since = signature?.authored_at;
        const laterEditors =
          since === undefined
            ? []
            : yield* store.threadsEditingFileSince({
                rootThreadId: (yield* store.getWorkstream(author.id))?.rootThreadId ?? author.id,
                excludeThreadId: author.id,
                absolutePath,
                since,
              });
        return {
          authorThreadId: author.id,
          authorTitle: author.title,
          authorSource,
          filePath,
          authoringSignature: signature !== null && isAuthoring(signature),
          authorArchived: author.archivedAt != null,
          sameFile,
          laterEditors,
        };
      }),
    ),
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
