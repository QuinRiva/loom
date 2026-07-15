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

const PROSE_AND_CODE_PATH_LINKS_MARKDOWN = `An orchestrator-style reply that hands back file paths as plain prose and inside a fenced block, the two shapes agents actually produce.

The verdict and the register are at /Users/julius/project/_findings/verdict.md and /Users/julius/project/_findings/findings_register.md — open both.

A relative hit with a position carries through: src/markdown-links.ts:42 should link too.

The same paths inside a fenced block stay exactly as typed but each path line is clickable:

\`\`\`text
/Users/julius/project/_findings/verdict.md
/Users/julius/project/_findings/findings_register.md
\`\`\`

None of these should link: a date like 01/02/2026, the words and/or, a flag value a/b, or a url like https://example.com/docs/guide.md.
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
  isStreaming = false,
): PreviewFixture {
  return {
    id,
    title,
    ...(description ? { description } : {}),
    render: () => (
      <TimelineLayoutFrame>
        <ChatMarkdown text={text} cwd={cwd} isStreaming={isStreaming} />
      </TimelineLayoutFrame>
    ),
  };
}

/**
 * Reproduces the user-message bubble wrapper from `UserTimelineRow` in
 * `MessagesTimeline.tsx` (right-aligned, bordered, `max-w-[80%]`) so the
 * wide-table bleed can be exercised in the bordered-bubble context, not just
 * the open assistant prose column.
 */
function userBubbleFixture(
  id: string,
  title: string,
  text: string,
  description?: string,
): PreviewFixture {
  return {
    id,
    title,
    ...(description ? { description } : {}),
    render: () => (
      <TimelineLayoutFrame>
        <div className="group flex flex-col items-end gap-1">
          <div className="chat-user-bubble relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
            <ChatMarkdown text={text} cwd={undefined} className="text-foreground" />
          </div>
        </div>
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
      markdownFixture(
        "prose-and-code-path-links",
        "Prose & code-block path links",
        PROSE_AND_CODE_PATH_LINKS_MARKDOWN,
        "Plain-prose paths become file chips; paths inside a fenced block become terminal-style clickable regions with unchanged text. Non-paths (dates, and/or, urls) stay plain.",
        "/Users/julius/project",
      ),
      markdownFixture(
        "prose-and-code-path-links-streaming",
        "Prose & code path links (streaming)",
        PROSE_AND_CODE_PATH_LINKS_MARKDOWN,
        "While streaming, prose linking and code-block decoration are deferred: the SAME content renders as plain text (no chips, no clickable code paths) until the message completes — satisfying the 'no per-token rescans' requirement.",
        "/Users/julius/project",
        true,
      ),
      markdownFixture("long-prose", "Long prose", LONG_PROSE_MARKDOWN),
      markdownFixture("mixed-document", "Mixed document", MIXED_DOCUMENT_MARKDOWN),
    ],
  },
  {
    id: "user-message",
    title: "User message bubble",
    fixtures: [
      userBubbleFixture(
        "user-wide-table",
        "Wide table in bubble",
        WIDE_TABLE_MARKDOWN,
        "A wide table inside the bordered user bubble should use the surrounding whitespace, not compress or break out of the border.",
      ),
      userBubbleFixture(
        "user-narrow-table",
        "Narrow table in bubble",
        NARROW_TABLE_MARKDOWN,
        "A small table must keep the bubble hugging its content, unchanged.",
      ),
      userBubbleFixture(
        "user-long-prose",
        "Long prose in bubble",
        LONG_PROSE_MARKDOWN,
        "Prose-only messages must keep today's readable width and not stretch.",
      ),
      userBubbleFixture(
        "user-mixed-document",
        "Mixed document in bubble",
        MIXED_DOCUMENT_MARKDOWN,
        "Prose stays at the readable measure while the wide table bleeds to use whitespace.",
      ),
    ],
  },
];

export const PREVIEW_FIXTURES: ReadonlyArray<PreviewFixture> = PREVIEW_GROUPS.flatMap(
  (group) => group.fixtures,
);
