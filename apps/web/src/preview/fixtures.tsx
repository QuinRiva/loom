import { type ReactNode } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { TimelineLayoutFrame } from "./TimelineLayoutFrame";

/**
 * A single previewable case. `render` returns the component already wrapped in
 * whatever layout context it needs to render faithfully (see
 * {@link TimelineLayoutFrame}). Add new components by appending groups — no
 * harness wiring changes required.
 */
export interface PreviewFixture {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly render: () => ReactNode;
}

export interface PreviewGroup {
  readonly id: string;
  readonly title: string;
  readonly fixtures: ReadonlyArray<PreviewFixture>;
}

/**
 * Wide table seeded from the PR #68 fix (markdown tables bleeding past the
 * `max-w-3xl` prose measure on wide displays). Kept here so the harness doubly
 * serves as a regression guard for that layout.
 */
const WIDE_TABLE_MARKDOWN = `Comparison of provider capabilities across a wide set of columns that overflows the prose measure:

| Provider | Model | Context | Streaming | Tools | Vision | Reasoning | Max output | Pricing tier | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | gpt-5.5 | 400k | Yes | Yes | Yes | High | 128k | Enterprise | Flagship general-purpose model with strong tool use |
| Anthropic | claude-opus-4-8 | 1M | Yes | Yes | Yes | High | 64k | Enterprise | Very large context, excellent long-document synthesis |
| Google | gemini-3-pro | 2M | Yes | Yes | Yes | Medium | 64k | Standard | Enormous context window, competitive multimodal |
| Meta | llama-4-405b | 256k | Yes | Partial | No | Medium | 32k | Open | Self-hostable, strong price/performance on-prem |
`;

const NARROW_TABLE_MARKDOWN = `A small table should stay narrow and hug its content — it must not stretch to the bleed budget:

| Key | Value |
| --- | --- |
| Status | Ready |
| Region | ap-southeast-2 |
`;

const CODE_BLOCK_MARKDOWN = `Here is a TypeScript snippet with a filename title and a long line that should scroll (or wrap when toggled):

\`\`\`ts title="timelineLayout.ts"
export function publishTimelineAvailableWidth(element: HTMLElement, viewportWidth: number): void {
  element.style.setProperty("--timeline-available-width", \`\${Math.round(viewportWidth)}px\`);
}
\`\`\`

And an inline \`const x = 1\` plus a plain fence:

\`\`\`
plain preformatted text
  with indentation preserved
\`\`\`
`;

const LONG_PROSE_MARKDOWN = `# Rendering long prose

This fixture exercises headings, paragraphs, lists, blockquotes and links at the real prose measure.

## A subheading

Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.

- First item with a [link to the docs](https://example.com/docs)
- Second item with **bold** and _italic_ emphasis
- Third item with \`inline code\`

1. Ordered one
2. Ordered two
3. Ordered three

> A blockquote to check the left border and muted colour treatment across multiple lines of wrapped text.

### Task list

- [x] Reproduce the timeline layout chain
- [ ] Add more component fixtures
`;

const INLINE_CODE_FILE_LINKS_MARKDOWN = `An orchestrator-style message that references files as plain inline code, the way agents actually write them.

The change lives in \`apps/web/src/components/ChatMarkdown.tsx\` and the detection rules in \`apps/web/src/markdown-links.ts\`. The failing assertion was around \`src/markdown-links.test.ts:138\`, and the absolute path \`/etc/hosts\` should link too. Config lives in \`package.json\` and \`tsconfig.json\`; docs in \`AGENTS.md\`.

None of these should become links: run \`vp run typecheck\` then \`vp run test\`, guard against \`foo.bar()\`, a \`HashMap<string, number>\`, the flag value \`a/b\`, a url like \`https://example.com/docs\`, and \`host:8080\`.

A fenced block must keep its normal code treatment, not linkify its contents:

\`\`\`ts
import foo from "src/foo.ts";
const path = "apps/web/src/index.ts";
\`\`\`
`;

const MIXED_DOCUMENT_MARKDOWN = `# Release notes

A representative mixed document combining prose, a wide table, code and a collapsible section.

Some introductory prose explaining the change with an [external reference](https://example.com).

| Change | Area | Impact | Reviewer | Shipped |
| --- | --- | --- | --- | --- |
| Wide-table bleed | web/chat | Medium | carl | Yes |
| Preview harness | web/dx | Low | carl | Pending |

\`\`\`bash
pnpm --filter @t3tools/web dev
\`\`\`

<details>
<summary>Implementation detail</summary>

The bleed budget is derived from \`--timeline-available-width\`, published by a ResizeObserver on the timeline viewport.

</details>
`;

function markdownFixture(
  id: string,
  title: string,
  text: string,
  description?: string,
  cwd?: string,
): PreviewFixture {
  return {
    id,
    title,
    ...(description ? { description } : {}),
    render: () => (
      <TimelineLayoutFrame>
        <ChatMarkdown text={text} cwd={cwd} />
      </TimelineLayoutFrame>
    ),
  };
}

export const PREVIEW_GROUPS: ReadonlyArray<PreviewGroup> = [
  {
    id: "chat-markdown",
    title: "ChatMarkdown",
    fixtures: [
      markdownFixture(
        "wide-table",
        "Wide table (bleed)",
        WIDE_TABLE_MARKDOWN,
        "Regression guard for PR #68: table bleeds past max-w-3xl up to the viewport budget.",
      ),
      markdownFixture(
        "narrow-table",
        "Narrow table",
        NARROW_TABLE_MARKDOWN,
        "A small table must hug its content, not stretch to the bleed budget.",
      ),
      markdownFixture("code-blocks", "Code blocks", CODE_BLOCK_MARKDOWN),
      markdownFixture(
        "inline-code-file-links",
        "Inline-code file links",
        INLINE_CODE_FILE_LINKS_MARKDOWN,
        "Plain inline-code path references become clickable file chips; non-path code spans and fenced blocks stay plain.",
        "/Users/julius/project",
      ),
      markdownFixture("long-prose", "Long prose", LONG_PROSE_MARKDOWN),
      markdownFixture("mixed-document", "Mixed document", MIXED_DOCUMENT_MARKDOWN),
    ],
  },
];

export const PREVIEW_FIXTURES: ReadonlyArray<PreviewFixture> = PREVIEW_GROUPS.flatMap(
  (group) => group.fixtures,
);
