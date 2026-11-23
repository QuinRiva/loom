import { controlCardModel } from "@t3tools/client-runtime/state/loom/controlCard";
import { EnvironmentId, ThreadId, type ControlPayload } from "@t3tools/contracts";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { openReport, openThreadLink } = vi.hoisted(() => ({
  openReport: vi.fn(),
  openThreadLink: vi.fn(),
}));

vi.mock("react-native", () => ({
  Pressable: (props: { children: ReactNode; accessibilityLabel?: string; onPress: () => void }) => (
    <button type="button" aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: (props: { label: string; accessibilityLabel?: string; onPress: () => void }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel ?? props.label}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref?.threadId === "child-reviewer" ? { title: "Review: control card" } : null,
}));
vi.mock("../workstream/workstreamNavigation.loom", () => ({ openReport }));
vi.mock("./thread-work-log", () => ({ ThreadDisclosureChevron: () => null }));
vi.mock("./useOpenThreadLink", () => ({ useOpenThreadLink: () => openThreadLink }));

import { ControlCardRow } from "./ControlCard.loom";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("orchestrator");
const reportPath = "/home/user/.t3/userdata/workstream-reports/child-reviewer.md";
// Invented, in the shape the dispatcher writes: an excerpt that would render as markdown.
const text =
  "[T3 Workstream control plane]\n\nFYI digest: the following items completed.\n\n## Raw";
const payload: ControlPayload = {
  kind: "digest",
  heading: "FYI digest: the following items completed.",
  items: [
    {
      kind: "gate-resolved",
      threadId: ThreadId.make("child-reviewer"),
      role: "reviewer",
      title: "Gate resolved (clean)",
      status: "clean",
      icon: "✅",
      reportPath,
      excerpt: "## Round 2 is ready: 0 must-fix",
      documents: ["plans/control-card/plan.mdx", "/work/notes/options.html"],
    },
  ],
};

function Harness(props: {
  onOpenDocument: (path: string) => void;
  renderMarkdown: (markdown: string) => ReactNode;
}) {
  const [rows, setRows] = useState<Record<string, boolean>>({});
  return (
    <ControlCardRow
      environmentId={environmentId}
      threadId={threadId}
      messageId="message-1"
      text={text}
      model={controlCardModel({ origin: "control_notice", controlPayload: payload }, text)!}
      expandedRows={rows}
      onToggleRow={(rowId) => setRows((current) => ({ ...current, [rowId]: !current[rowId] }))}
      renderMarkdown={props.renderMarkdown}
      onOpenDocument={props.onOpenDocument}
      iconColor="#888"
    />
  );
}

it("starts collapsed, expands to excerpts and the raw text, and opens report, thread and documents", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onOpenDocument = vi.fn();
  const renderMarkdown = vi.fn((markdown: string) => <p data-markdown>{markdown}</p>);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label || candidate.textContent === label,
    );
    expect(found, label).toBeDefined();
    return found!;
  };
  try {
    act(() =>
      root.render(<Harness onOpenDocument={onOpenDocument} renderMarkdown={renderMarkdown} />),
    );

    // Collapsed: the header, the entry under its live title with its verdict, the chips; no markdown.
    expect(container.textContent).toContain("Digest");
    expect(container.textContent).toContain("Review: control card");
    expect(container.textContent).toContain("Clean");
    expect(container.textContent).not.toContain("Gate resolved · clean");
    expect(container.textContent).toContain("reviewer · Gate resolved (clean)");
    expect(container.textContent).toContain("control-card/plan.mdx");
    expect(container.textContent).toContain("options.html");
    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Show the text the agent received");

    act(() => button("Digest: FYI digest: the following items completed.").click());
    expect(container.querySelector("[data-markdown]")?.textContent).toBe(
      "## Round 2 is ready: 0 must-fix",
    );

    act(() => button("Show the text the agent received").click());
    // Verbatim, outside any markdown render.
    const raw = [...container.querySelectorAll("span")].find((span) => span.textContent === text);
    expect(raw).toBeDefined();
    expect(renderMarkdown).not.toHaveBeenCalledWith(text);

    act(() => button("Open report: Review: control card").click());
    expect(openReport).toHaveBeenCalledWith(environmentId, threadId, reportPath);
    act(() => button("Open thread").click());
    expect(openThreadLink).toHaveBeenCalledWith({ environmentId, threadId: "child-reviewer" });
    act(() => button("Open plans/control-card/plan.mdx").click());
    act(() => button("Open /work/notes/options.html").click());
    expect(onOpenDocument.mock.calls).toEqual([
      ["plans/control-card/plan.mdx"],
      ["/work/notes/options.html"],
    ]);
  } finally {
    act(() => root.unmount());
  }
});
