/**
 * File-centric goal HTTP routes for the web client.
 *
 * `GET /api/goals` exposes the derived goal index. `POST /api/goals`
 * scaffolds a goal package by writing `goals/<slug>/goal.md`; the file remains
 * the source of truth and the next scan picks it up.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GoalsService } from "./GoalsService.ts";

interface CreateGoalRequest {
  readonly projectId: string;
  readonly threadId?: string | null;
  readonly slug: string;
  readonly title?: string;
  readonly goalParagraph?: string;
}

const cleanSlug = (slug: string) =>
  slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const goalMarkdown = (input: { title: string; goalParagraph: string }) =>
  `# ${input.title}\n\n## Goal\n${input.goalParagraph}\n\n## Tasks\n- [ ] Define the next task\n`;

export const goalsRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/goals",
    Effect.gen(function* () {
      const goalsService = yield* GoalsService;
      const goals = yield* goalsService.rescan();
      return HttpServerResponse.jsonUnsafe({ goals });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/goals",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json) as unknown as CreateGoalRequest;
      const slug = cleanSlug(body.slug);
      if (!slug) return HttpServerResponse.text("Goal slug is required.", { status: 400 });

      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === body.projectId);
      if (!project) return HttpServerResponse.text("Project not found.", { status: 404 });

      const thread = body.threadId
        ? snapshot.threads.find((candidate) => candidate.id === body.threadId)
        : undefined;
      const worktreePath = thread?.worktreePath ?? project.workspaceRoot;
      const packageDir = join(worktreePath, "goals", slug);
      const goalFile = join(packageDir, "goal.md");
      if (!existsSync(goalFile)) {
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(
          goalFile,
          goalMarkdown({
            title: body.title?.trim() || slug,
            goalParagraph: body.goalParagraph?.trim() || `Capture the goal for ${body.title?.trim() || slug}.`,
          }),
          "utf8",
        );
      }

      const goalsService = yield* GoalsService;
      const goals = yield* goalsService.rescan();
      return HttpServerResponse.jsonUnsafe({ goal: goals.find((goal) => goal.slug === slug) ?? null });
    }),
  ),
);
