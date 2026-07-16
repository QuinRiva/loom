import { assert, it } from "@effect/vitest";

import { EnvironmentInternalError } from "@t3tools/contracts";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("surfaces the cause message for unexpected Error failures", () => {
  const cause = new Error("connect ECONNREFUSED 127.0.0.1:13900");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(
    error.message,
    "Failed to call the running server: connect ECONNREFUSED 127.0.0.1:13900",
  );
  assert.strictEqual(error.cause, cause);
});

it("falls back to a generic message for non-Error failures", () => {
  const cause = "boom";

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});
