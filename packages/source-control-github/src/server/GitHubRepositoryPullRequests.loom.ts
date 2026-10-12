/**
 * Loom's repository-wide pull request listing: every pull request in a repository, newest
 * update first, in pages of a hundred. `GitManager`'s `repositoryPrListCache` reads it once per
 * repository so every worktree's PR badge comes from one listing instead of a lookup per branch.
 * `GitHubSourceControlProvider.make` binds it as `listRepositoryChangeRequests`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { readGraphQlPages } from "./githubGraphQl.ts";

export const repositoryPullRequestsQuery = (nodeSelection: string) =>
  `query RepositoryPullRequests($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${nodeSelection} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PullRequestsPage = Schema.Struct({
  nodes: Schema.Array(Schema.Unknown),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
});
type PullRequestsPage = typeof PullRequestsPage.Type;

export const decodeRepositoryPullRequests = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.NullOr(Schema.Struct({ pullRequests: PullRequestsPage })),
    }),
  }),
);

const nodeCount = (pages: ReadonlyArray<PullRequestsPage>) =>
  pages.reduce((count, page) => count + page.nodes.length, 0);

/** Up to `limit` raw pull request nodes, reading each page with `readPage`. */
export const readRepositoryPullRequestNodes = <E, R>(
  limit: number,
  readPage: (page: {
    readonly first: number;
    readonly after: string | null;
  }) => Effect.Effect<PullRequestsPage, E, R>,
) =>
  readGraphQlPages<PullRequestsPage, E, R>(
    (after, pages) => readPage({ after, first: Math.min(100, limit - nodeCount(pages)) }),
    {
      nextCursor: (page) => (page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null),
      until: (pages) => nodeCount(pages) >= limit,
    },
  ).pipe(Effect.map(({ pages }) => pages.flatMap((page) => page.nodes).slice(0, limit)));
