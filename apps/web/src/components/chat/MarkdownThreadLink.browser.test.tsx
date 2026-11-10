import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const state = vi.hoisted(() => ({
  reply: null as unknown,
  remote: null as unknown,
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadShell: ((ref: { environmentId: string; threadId: string } | null) =>
    ref?.environmentId === "remote"
      ? state.remote
      : ref?.threadId === "held-thread" // loom: a local shell only under its decoded id
        ? { ...(state.remote as object), environmentId: ref.environmentId, id: ref.threadId }
        : null) as never,
  useThreadRefs: (enabled = true) =>
    enabled
      ? [{ environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("older-thread") }]
      : [],
  useProject: (ref: { projectId: string } | null) =>
    ref?.projectId === "essay-project" ? ({ title: "Essays" } as never) : null,
}));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => (
    <span role="img" aria-label="Essays project icon">
      P
    </span>
  ),
}));
vi.mock(import("../contextChipParts"), () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: { threadLinkMetadata: () => state.reply } as never,
}));

function setup() {
  const reply = Atom.make<
    AsyncResult.AsyncResult<Record<string, { title: string; projectId: ProjectId | null }>, string>
  >(AsyncResult.initial());
  state.reply = reply;
  state.remote = {
    environmentId: EnvironmentId.make("remote"),
    id: ThreadId.make("older-thread"),
    title: "Remote thread",
    projectId: ProjectId.make("essay-project"),
    source: {}, // loom: ThreadMention reads the shell's workstream role
  };
  return { reply, registry: AtomRegistry.make() };
}

it.each([
  { legacy: false, encoded: false },
  { legacy: true, encoded: false },
  { legacy: false, encoded: true },
])(
  "resolves an unloaded thread with its icon and the correct destination, %j",
  async ({ legacy, encoded }) => {
    const { reply, registry } = setup();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make(encoded ? "older%2Dthread" : "older-thread");
    await using screen = await render(
      <RegistryContext value={registry}>
        <MarkdownThreadLink
          environmentId={environmentId}
          link={{ environmentId: legacy ? null : environmentId, threadId }}
          label={null}
        />
      </RegistryContext>,
    );
    await expect
      .element(screen.getByRole("link", { name: "Thread, Thread", exact: true }))
      .toBeVisible();
    await act(() => registry.set(reply, AsyncResult.failure(Cause.fail("offline"))));
    await expect
      .element(screen.getByRole("link", { name: "Thread, Thread", exact: true }))
      .toBeVisible();
    await act(() =>
      registry.set(
        reply,
        AsyncResult.success({
          [threadId]: { title: "Older essay", projectId: ProjectId.make("essay-project") },
          ...(encoded
            ? {
                "older-thread": {
                  title: "Decoded essay",
                  projectId: ProjectId.make("essay-project"),
                },
              }
            : {}),
        }),
      ),
    );
    const link = screen.getByRole("link", { name: "Thread, Older essay" });
    await expect.element(link).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "Essays project icon" })).toBeVisible();
    await link.click();
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe(
        `/environment/${encodeURIComponent(threadId)}`,
      ),
    );
    if (encoded) {
      await act(() =>
        registry.set(
          reply,
          AsyncResult.success({
            "older-thread": { title: "Decoded essay", projectId: ProjectId.make("essay-project") },
          }),
        ),
      );
      const decoded = screen.getByRole("link", { name: "Thread, Decoded essay" });
      await expect.element(decoded).toBeVisible();
      await decoded.click();
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/environment/older-thread"),
      );
    }
    await act(() => registry.set(reply, AsyncResult.success({})));
    if (legacy) {
      // loom: a held shell reads as Loom's status-led mention, not upstream's chip
      const remote = screen.getByRole("link", { name: "Remote thread", exact: true });
      await expect.element(remote).toBeVisible();
      await remote.click();
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/remote/older-thread"),
      );
    } else {
      await expect
        .element(screen.getByText("Thread no longer available", { exact: true }))
        .toBeVisible();
    }
  },
);

// loom: DL-1818 — a percent-encoded link to a thread the client holds is Loom's mention, not a chip.
it("reads the decoded shell of a percent-encoded link", async () => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const environmentId = EnvironmentId.make("environment");
  await using screen = await render(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={environmentId}
        link={{ environmentId, threadId: ThreadId.make("held%2Dthread") }}
        label={null}
      />
    </RegistryContext>,
  );
  const mention = screen.getByRole("link", { name: "Remote thread", exact: true });
  await expect.element(mention).toBeVisible();
  await mention.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment/held-thread"),
  );
});
