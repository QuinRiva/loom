import { useContext } from "react";
import { z } from "zod";

import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";

import { ChatMarkdownAssetImage } from "~/components/ChatMarkdown";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { PlanDocumentContext } from "../planDocument";

/**
 * The `<Image>` block — a screenshot or exported diagram that lives **beside the
 * document on disk**, referenced by a path relative to it
 * (`<Image src="shots/before.png" caption="…" />`).
 *
 * Path resolution follows the app's existing file-relative image surface rather
 * than inventing a second one: the src is classified by
 * {@link classifyMarkdownImageSource} against the document's directory (the same
 * call `ChatMarkdown` makes for a `.md` preview's `![](shot.png)`), and a
 * resolved filesystem path is loaded through a signed `media-file` asset URL —
 * never handed to the browser as a bare path. `https:`/`data:` sources render
 * directly.
 *
 * Outside the app (the headless renderer in `scripts/lint-plan.mjs`) there is no
 * thread to sign a URL against, so the figure falls back to a `file://` src,
 * which is what makes `--out` HTML show the real image when opened locally.
 */

export interface ImageData {
  /** Path relative to the document (`shots/before.png`), an absolute host path, or an https:/data: URL. */
  src: string;
  alt?: string;
  caption?: string;
  /** Display width cap in px; the image keeps its aspect ratio. Defaults to the prose measure. */
  width?: number;
}

const imageSchema = z.object({
  src: z.string().trim().min(1).max(2000),
  alt: z.string().max(300).optional(),
  caption: z.string().max(500).optional(),
  width: z.number().int().positive().max(4000).optional(),
}) as unknown as z.ZodType<ImageData>;

const imageMdx: BlockMdxConfig<ImageData> = {
  tag: "Image",
  toAttrs: (data) => ({
    src: data.src,
    alt: data.alt,
    caption: data.caption,
    width: data.width,
  }),
  fromAttrs: (attrs) =>
    ({
      src: attrs.string("src") ?? "",
      alt: attrs.string("alt"),
      caption: attrs.string("caption"),
      width: attrs.number("width"),
    }) as ImageData,
};

/** `file:///abs/path with spaces.png` — the only form a locally-opened static
 * render (lint `--out`) can load, and one no in-app render ever reaches. */
function fileUrl(path: string): string {
  return `file://${path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
}

function ImageRead({ data, blockId }: PlanBlockReadProps<ImageData>) {
  const location = useContext(PlanDocumentContext);
  const source = classifyMarkdownImageSource(data.src, location?.baseDir);
  const alt = data.alt ?? data.caption ?? "";
  const style = data.width ? { maxWidth: data.width } : undefined;

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="image"
      // The resolved host path, so the headless check can confirm the file is
      // actually there (a typo'd screenshot path renders as a broken image).
      data-plan-image-path={source._tag === "WorkspaceFile" ? source.path : undefined}
      className="my-6 flex flex-col items-center gap-2"
      style={style}
    >
      {source._tag === "WorkspaceFile" && location?.threadRef ? (
        <ChatMarkdownAssetImage
          environmentId={location.threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: location.threadRef.threadId,
            path: source.path,
          }}
          alt={alt}
          standalone
          workspaceRoot={location.baseDir}
        />
      ) : source._tag === "Blocked" ? (
        <div className="w-full rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          Image “{data.src}” could not be resolved — write the path relative to this document.
        </div>
      ) : (
        <img
          src={source._tag === "Direct" ? source.uri : fileUrl(source.path)}
          alt={alt}
          className="max-w-full rounded-lg border border-border"
        />
      )}
      {data.caption ? (
        <figcaption className="text-center text-xs text-muted-foreground">
          {data.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export const imageBlock: PlanBlock<ImageData> = {
  schema: imageSchema,
  mdx: imageMdx,
  Read: ImageRead,
};
