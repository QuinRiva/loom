import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

/**
 * Dev-only component preview harness. The `/preview` branch in `__root.tsx`'s
 * `beforeLoad` skips the auth gate for this path under `import.meta.env.DEV`.
 *
 * The harness UI + fixtures are pulled in via a `DEV`-gated dynamic import, so
 * in a production build `import.meta.env.DEV` is statically `false`, the
 * `import()` becomes dead code, and the whole fixture graph is tree-shaken out
 * — the harness never ships. In production this route renders nothing.
 */
export const Route = createFileRoute("/preview")({
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import("../preview/PreviewApp"), "PreviewApp")
    : () => null,
});
