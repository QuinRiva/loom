import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

/**
 * Dev-only: `__root.tsx`'s `beforeLoad` skips the auth gate here under `import.meta.env.DEV`,
 * and the harness loads through a `DEV`-gated dynamic import, so production tree-shakes the
 * fixture graph out and this route renders nothing.
 */
export const Route = createFileRoute("/preview")({
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import("../preview/PreviewApp"), "PreviewApp")
    : () => null,
});
