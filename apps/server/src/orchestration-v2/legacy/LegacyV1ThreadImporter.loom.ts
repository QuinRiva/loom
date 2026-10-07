/**
 * loom: what a V1 message's Loom columns become on import (DL-610).
 *
 * V1 stamped every Loom-composed user-role message with
 * `projection_thread_messages.origin` (absent = a human) and, for digests and
 * yields, `control_payload_json`. V2 recognises the same messages by
 * `message.loom` and `createdBy: "agent"` — exactly what the dispatcher writes
 * on a new control message — so an imported one renders, settles and counts
 * as human the same way. A payload that does not decode is dropped: the card
 * falls back to the message's raw text.
 */
import { ControlPayload, LoomMessageOrigin, type LoomMessageFields } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface LegacyLoomMessageColumns {
  readonly role: "user" | "assistant";
  readonly origin?: string | null;
  readonly control_payload_json?: string | null;
}

const decodeOrigin = Schema.decodeUnknownOption(LoomMessageOrigin);
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ControlPayload));

export function importedLoomFields(row: LegacyLoomMessageColumns): {
  readonly createdBy: "user" | "agent";
  readonly loom?: LoomMessageFields;
} {
  const origin = Option.getOrUndefined(decodeOrigin(row.origin));
  if (row.role !== "user") return { createdBy: "agent" };
  if (origin === undefined) return { createdBy: "user" };
  const controlPayload =
    row.control_payload_json == null
      ? undefined
      : Option.getOrUndefined(decodePayload(row.control_payload_json));
  return {
    createdBy: "agent",
    loom: {
      origin,
      humanAuthored: false,
      ...(controlPayload === undefined ? {} : { controlPayload }),
    },
  };
}
