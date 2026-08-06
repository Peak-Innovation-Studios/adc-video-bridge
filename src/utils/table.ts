/**
 * Fixed-width column helpers for the discovery CLI's table output.
 *
 * console.log('%-20s', v) does not pad: Node's util.format supports only
 * %s/%d/%i/%f/%j/%o/%O/%c/%%, with no width or flag syntax. '%-20s' is
 * therefore not a specifier at all — it survives into the output verbatim and
 * the value is appended after the whole format string.
 */

/** Pad each value to its column and join with a single space. Never truncates. */
export function formatRow(values: string[], widths: number[]): string {
  return values
    .map((value, i) => value.padEnd(widths[i] ?? 0))
    .join(' ')
    .trimEnd();
}

/** Width of a fully populated row, for sizing the separator rule beneath it. */
export function rowWidth(widths: number[]): number {
  return widths.reduce((sum, w) => sum + w, 0) + (widths.length - 1);
}
