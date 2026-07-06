import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(30);

export const isRuntimeStateProcessAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as { readonly code?: unknown }).code
          : undefined;
      return code !== "ESRCH";
    }
  });
