import { useState } from "react";

import { cn } from "../lib/utils";
import { PREVIEW_FIXTURES, PREVIEW_GROUPS } from "./fixtures";

/**
 * The dev-only component preview harness UI. Lives in its own module so the
 * route can pull it in behind a `import.meta.env.DEV` dynamic import — the
 * whole fixture graph (and its sample markdown) is then code-split into a
 * chunk that production never references, so it is tree-shaken out entirely.
 */
export function PreviewApp() {
  const [activeId, setActiveId] = useState<string>(PREVIEW_FIXTURES[0]?.id ?? "");

  const activeFixture =
    PREVIEW_FIXTURES.find((fixture) => fixture.id === activeId) ?? PREVIEW_FIXTURES[0];

  return (
    <div className="flex h-dvh min-h-0 bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/40">
        <div className="border-b border-border px-4 py-3">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            Component preview
          </p>
        </div>
        <nav className="flex flex-col gap-4 p-3">
          {PREVIEW_GROUPS.map((group) => (
            <div key={group.id} className="flex flex-col gap-1">
              <p className="px-2 text-xs font-medium text-muted-foreground">{group.title}</p>
              {group.fixtures.map((fixture) => (
                <button
                  key={fixture.id}
                  type="button"
                  onClick={() => setActiveId(fixture.id)}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    fixture.id === activeFixture?.id
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/80 hover:bg-accent/50",
                  )}
                >
                  {fixture.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeFixture ? (
          <>
            <header className="shrink-0 border-b border-border px-5 py-3">
              <h1 className="text-sm font-medium text-foreground">{activeFixture.title}</h1>
              {activeFixture.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{activeFixture.description}</p>
              ) : null}
            </header>
            <div className="min-h-0 flex-1">{activeFixture.render()}</div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No fixtures registered.
          </div>
        )}
      </main>
    </div>
  );
}
