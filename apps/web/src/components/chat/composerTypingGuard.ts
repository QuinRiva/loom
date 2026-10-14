export const COMPOSER_TYPING_IDLE_MS = 1500;

export function createComposerTypingGuardState() {
  return {
    seen: new Set<string>(),
    held: new Set<string>(),
    focused: false,
    // loom: a citation comment pop-up is open in the composer; takeover would unmount it.
    commenting: false,
    lastTypedAt: -Infinity,
  };
}

type TypingGuardEvent =
  | { type: "requests"; requestIds: readonly string[]; now: number }
  | { type: "type"; now: number }
  | { type: "focus" | "blur" | "send" | "idle" }
  | { type: "comment"; open: boolean }; // loom: citation comment pop-up mounted/unmounted

export function updateComposerTypingGuard(
  state: ReturnType<typeof createComposerTypingGuardState>,
  event: TypingGuardEvent,
) {
  switch (event.type) {
    case "requests": {
      const seen = new Set(state.seen);
      const held = new Set([...state.held].filter((id) => event.requestIds.includes(id)));
      for (const id of event.requestIds) {
        if (
          !seen.has(id) &&
          // loom: an open citation comment holds regardless of typing pauses.
          (state.commenting ||
            (state.focused && event.now - state.lastTypedAt < COMPOSER_TYPING_IDLE_MS))
        ) {
          held.add(id);
        }
        seen.add(id);
      }
      return { ...state, seen, held };
    }
    case "type":
      return { ...state, lastTypedAt: event.now };
    case "focus":
      return { ...state, focused: true };
    case "blur":
    case "send":
    case "idle":
      // loom: holds outlive pauses and focus moves until the citation comment closes.
      if (state.commenting) {
        return { ...state, focused: event.type === "blur" ? false : state.focused };
      }
      return {
        ...state,
        held: new Set<string>(),
        lastTypedAt: -Infinity,
        focused: event.type === "blur" ? false : state.focused,
      };
    // loom: closing the citation comment releases what it held.
    case "comment":
      return event.open
        ? { ...state, commenting: true }
        : { ...state, commenting: false, held: new Set<string>(), lastTypedAt: -Infinity };
  }
}
