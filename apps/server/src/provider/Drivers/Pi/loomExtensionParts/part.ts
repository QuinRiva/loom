// loom: STUB for seam 3 — 3a's `provider/Drivers/Pi/loomExtension.ts` exports this
// interface; at integration the parts import it from there and this file goes.
/**
 * One named piece of Loom's pi extension (plan seam 3). `source` is a function
 * body the assembler wraps as `(pi, ctx) => { … }` and runs once when pi loads
 * the extension, where `pi` is pi's ExtensionAPI and
 * `ctx = { profile(): Promise<SessionProfile>, endpoint, token }`. The body
 * imports nothing (Node built-ins via `process.getBuiltinModule`).
 *
 * @module provider/Drivers/Pi/loomExtensionParts/part
 */
export interface LoomExtensionPart {
  readonly name: string;
  readonly source: string;
}
