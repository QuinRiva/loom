import { useContext, useState, type ReactNode } from "react";
import { z } from "zod";

import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";

import { ChatMarkdownAssetImage, markdownImageCopy } from "~/components/chat/ChatMarkdownMedia";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { PlanDocumentContext } from "../planDocument";

/**
 * `<Image>`: a picture beside the document, by relative path. Resolved like `ChatMarkdown`
 * images ({@link classifyMarkdownImageSource}) and loaded via a signed `media-file` URL,
 * never a bare path. Headless (`lint-plan.mjs`) there is no thread to sign against, so it
 * falls back to `file://`, which makes `--out` HTML show the real image locally.
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

/** `file:///abs/path%20with%20spaces.png` — the only form a locally-opened static
 * render can load, and one no in-app render ever reaches. `encodeURI` (not a
 * per-segment encode) keeps a Windows drive letter's `:` intact. */
function fileUrl(path: string): string {
  return `file://${encodeURI(path.replace(/\\/g, "/"))}`;
}

/**
 * The picture itself plus the resolved host path for the caller to stamp. Shared
 * by the `<Image>` block and the markdown `img` mapping so both resolve, sign,
 * and lint-check identically; only the wrapper differs (a flow `<figure>` vs an
 * inline `<span>` that is legal inside a paragraph).
 */
function usePlanImage(
  src: string,
  alt: string,
  title?: string,
): { path?: string; picture: ReactNode } {
  const location = useContext(PlanDocumentContext);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const source = classifyMarkdownImageSource(src, location?.baseDir);
  // A markdown title (`![alt](src "title")`) is authored content, so it survives
  // into the copyable markdown — the app's own treatment of it — and stands in
  // for a missing alt. It is never a native `title` tooltip (repo lint rule).
  const copyMarkdown = markdownImageCopy(alt, src, title);
  const label = alt || title || "";
  const dialog = preview ? (
    <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
  ) : null;

  if (source._tag === "Blocked") {
    return {
      picture: (
        <span className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          Image “{src}” could not be resolved. Write the path relative to this document.
        </span>
      ),
    };
  }
  if (source._tag === "WorkspaceFile" && location?.threadRef) {
    return {
      path: source.path,
      picture: (
        <>
          <ChatMarkdownAssetImage
            environmentId={location.threadRef.environmentId}
            resource={{
              _tag: "media-file",
              threadId: location.threadRef.threadId,
              path: source.path,
            }}
            alt={label}
            copyMarkdown={copyMarkdown}
            standalone
            // A document column, not a chat bubble: fill it, like the static render.
            uncapWidth
            // The project root, not the document's directory: this is what the
            // media actions label and their "open file" path are relative to.
            workspaceRoot={location.cwd}
            onImageExpand={setPreview}
          />
          {dialog}
        </>
      ),
    };
  }
  return {
    ...(source._tag === "WorkspaceFile" ? { path: source.path } : {}),
    picture: (
      <img
        src={source._tag === "Direct" ? source.uri : fileUrl(source.path)}
        alt={label}
        data-markdown-copy={copyMarkdown}
        // The same box the in-app asset image keeps (`maxHeightRem` 30).
        className="max-h-[30rem] max-w-full rounded-lg border border-border"
      />
    ),
  };
}

function ImageRead({ data, blockId }: PlanBlockReadProps<ImageData>) {
  const { path, picture } = usePlanImage(data.src, data.alt ?? data.caption ?? "");
  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="image"
      // The resolved host path, so the headless check can confirm the file is
      // actually there (a typo'd screenshot path renders as a broken image).
      data-plan-image-path={path}
      className="my-6 flex flex-col items-center gap-2"
      style={data.width ? { maxWidth: data.width } : undefined}
    >
      {picture}
      {data.caption ? (
        <figcaption className="text-center text-xs text-muted-foreground">
          {data.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * The renderer's `img` component, so markdown `![alt](shot.png)` resolves like `<Image>`
 * instead of a bare `<img>` silently broken against the app origin. Inline-level so it
 * stays legal inside the paragraph markdown wraps it in.
 */
export function PlanMarkdownImage({ src, alt, title }: Record<string, unknown>) {
  const { path, picture } = usePlanImage(
    typeof src === "string" ? src : "",
    typeof alt === "string" ? alt : "",
    typeof title === "string" ? title : undefined,
  );
  return (
    <span data-plan-image-path={path} className="inline-block max-w-full align-middle">
      {picture}
    </span>
  );
}

export const imageBlock: PlanBlock<ImageData> = {
  schema: imageSchema,
  mdx: imageMdx,
  Read: ImageRead,
};
