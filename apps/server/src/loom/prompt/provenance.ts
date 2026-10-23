// LOOM-ONLY. The report line that names a human author. The author labels the
// pi adapter prepends to every message live with the adapter, in
// `@t3tools/provider-pi/server/loom` (provenance.loom.ts).

/**
 * Appended to `QUIESCENT_REPORT_HEADER` when the turn the quiet child ended was
 * started by the human: the parent otherwise reads the last message as the
 * child's own stopping point.
 */
export const QUIESCENT_HUMAN_STARTED_LINE =
  "> The turn it ended was started by a message from the human, which this file does not quote; read the thread before acting on it.";
