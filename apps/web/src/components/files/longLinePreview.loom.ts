/**
 * loom: the preview virtualizes by line, which bounds the DOM for normal files of any size but
 * not the text ONE line contributes: ~100 lines stay resident whatever their length, so a
 * ~600 KB file of 10,000-char lines puts the whole file in the DOM, and with wrap on a 600 KB
 * single-line file lays out 409,616 px tall.
 */

/**
 * Minified output, data URIs or single-line JSON, not hand-written source. Max line length in
 * this repo is bimodal (hand-written tops out at 5,078, generated starts at 20,527), so 10,000
 * splits near-empty space. Known cost: `Icons.tsx` (12,251, an SVG path blob) opens elided and
 * read-only; if that bites, trigger on aggregate over-long text instead of any single line.
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
