/**
 * loom: messages between the mobile app and its document viewer page. Android exposes the
 * app's channel to every frame, so page messages after `ready` carry the token from `init`,
 * which only the top frame receives. Fields are only ever added, as optional ones.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DOCUMENT_VIEWER_PATH = "/document-viewer.html";
export const DOCUMENT_VIEWER_PROTOCOL = 1;
/** The read budget for a document, matching web's `.mdx` preview (the server clamps to it). */
export const DOCUMENT_READ_MAX_BYTES = 8 * 1024 * 1024;

const Token = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128));
const ImageRequestId = Schema.Number.check(Schema.isInt());

const ReadyMessage = Schema.Struct({ type: Schema.Literal("ready"), protocol: Schema.Number });
const RenderedMessage = Schema.Struct({
  type: Schema.Literal("rendered"),
  token: Token,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
const LinkMessage = Schema.Struct({
  type: Schema.Literal("link"),
  token: Token,
  href: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
const ImageRequestMessage = Schema.Struct({
  type: Schema.Literal("image-request"),
  token: Token,
  id: ImageRequestId,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});

const DocumentViewerPageMessage = Schema.Union([
  ReadyMessage,
  RenderedMessage,
  LinkMessage,
  ImageRequestMessage,
]);
export type DocumentViewerPageMessage = typeof DocumentViewerPageMessage.Type;

const InitMessage = Schema.Struct({
  type: Schema.Literal("init"),
  protocol: Schema.Number,
  token: Token,
  source: Schema.String,
  /** Workspace-relative (or absolute) path of the document, as the app opened it. */
  filePath: Schema.String,
  /** Absolute directory holding the document: the base for its relative image paths. */
  baseDir: Schema.String,
  /** Project root, for labels; absent for an attachment. */
  cwd: Schema.optionalKey(Schema.String),
  appearance: Schema.Literals(["light", "dark"]),
});
/** `url` is null where the app cannot sign the path (an attached document has no workspace). */
const ImageUrlMessage = Schema.Struct({
  type: Schema.Literal("image-url"),
  id: ImageRequestId,
  url: Schema.NullOr(Schema.String),
});

const DocumentViewerAppMessage = Schema.Union([InitMessage, ImageUrlMessage]);
export type DocumentViewerAppMessage = typeof DocumentViewerAppMessage.Type;
export type DocumentViewerInit = typeof InitMessage.Type;

const decodePageMessage = Schema.decodeUnknownOption(DocumentViewerPageMessage);
const decodeAppMessage = Schema.decodeUnknownOption(DocumentViewerAppMessage);

/**
 * The app's gate on what the page posts: a JSON message of a known type that carries this
 * load's token (`ready` excepted, since it precedes the token). Anything else is dropped.
 */
export function acceptDocumentViewerPageMessage(
  data: string,
  token: string,
): DocumentViewerPageMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const message = Option.getOrNull(decodePageMessage(parsed));
  return message !== null && (message.type === "ready" || message.token === token) ? message : null;
}

/** The page's decode of what the app sends; the caller checks the event came from the app. */
export function readDocumentViewerAppMessage(data: unknown): DocumentViewerAppMessage | null {
  return Option.getOrNull(decodeAppMessage(data));
}

/** The script the app injects to hand the top frame a message; a frame cannot observe it. */
export function documentViewerAppMessageScript(message: DocumentViewerAppMessage): string {
  return `window.postMessage(${JSON.stringify(message)}, window.location.origin); true;`;
}
