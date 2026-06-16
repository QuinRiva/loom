/**
 * `GET /api/goals` — the file-centric goal index for the web client.
 *
 * Modeled on the raw HTTP route layers in `http.ts` (e.g. the OTLP proxy).
 * Triggers a fresh scan so a newly written or edited `goal.md` is reflected
 * on the next poll, then returns the index entries plus per-goal task
 * progress. The goal files are the source of truth (architecture v3); this
 * route exposes a derived, never-authoritative view.
 */
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { GoalsService } from "./GoalsService.ts";

export const goalsRouteLayer = HttpRouter.add(
  "GET",
  "/api/goals",
  Effect.gen(function* () {
    const goalsService = yield* GoalsService;
    const goals = yield* goalsService.rescan();
    return HttpServerResponse.jsonUnsafe({ goals });
  }),
);
