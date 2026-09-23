/**
 * loom: bounding the file preview's DOM for files that line virtualization
 * cannot bound.
 *
 * The preview virtualizes by LINE — `@pierre/diffs` paints only the lines near
 * the viewport — which bounds the DOM for any file whose lines are a normal
 * length. Measured in the panel: a 717 KB / 10,002-line TypeScript file paints
 * ~22 KB of text, and a 676 KB / 7,953-line markdown file paints ~24 KB. File
 * size is not the problem.
 *
 * What the virtualizer has no bound on is how much text ONE line contributes,
 * so a file with very long lines defeats it completely. Sweeping line length
 * across a fixed ~600 KB file (text resident in the DOM, wrap off):
 *
 *     80 chars/line →  23 KB      2,000 → 215 KB
 *    200            →  35 KB      5,000 → 515 KB
 *    500            →  65 KB     10,000 → the whole file
 *  1,000            → 115 KB    200,000 → the whole file, 753 ms of long task
 *
 * The growth is linear because the virtualizer keeps ~100 lines resident
 * regardless of their length. With word wrap on — the default — the same
 * 600 KB single-line file also lays that one line out 409,616 px tall.
 */

/**
 * A line this long is not hand-written source or prose: it is minified output,
 * a base64 data URI, or a single-line JSON blob. Below this the ordinary
 * editable surface stays in charge, so even an unwrapped markdown paragraph is
 * never touched.
 *
 * Max line length across this repo's 6,069 tracked source and doc files is
 * sharply bimodal, which is what makes a single cut safe: the median file tops
 * out at 57 characters and p99 at 72; the longest *hand-written* files reach
 * 5,078 (`PiDriver.ts`), 2,330, 1,862, 1,787…; and the generated/minified ones
 * start again at 22,956 and climb past 3 million. Nothing sits between ~5.1k
 * and ~22.9k, so 10,000 splits an empty gap — only 31 files (0.5%) trip it, all
 * of them generated. A tighter cut would start eliding real source for no gain.
 */
export const UNBOUNDED_LINE_LENGTH = 10_000;

/**
 * How much of an over-long line the preview paints once a file has tripped
 * `UNBOUNDED_LINE_LENGTH`: enough to identify the line, small enough to keep
 * resident text near a healthy file's.
 */
export const LONG_LINE_RENDER_CAP = 1_000;

/** Whether any single line is long enough to defeat line virtualization. */
export function hasUnboundedLines(contents: string): boolean {
  for (let start = 0; ;) {
    const next = contents.indexOf("\n", start);
    if (next < 0) return contents.length - start > UNBOUNDED_LINE_LENGTH;
    if (next - start > UNBOUNDED_LINE_LENGTH) return true;
    start = next + 1;
  }
}

/**
 * Cap every over-long line, marking what was left out. Only ever fed to the
 * read-only preview: elided text must never reach the editable surface, whose
 * `onChange` writes straight back to the file.
 */
export const elideLongLines = (contents: string): string =>
  contents
    .split("\n")
    .map((line) =>
      line.length > LONG_LINE_RENDER_CAP
        ? `${line.slice(0, LONG_LINE_RENDER_CAP)}… ⟨${(
            line.length - LONG_LINE_RENDER_CAP
          ).toLocaleString()} more characters⟩`
        : line,
    )
    .join("\n");
