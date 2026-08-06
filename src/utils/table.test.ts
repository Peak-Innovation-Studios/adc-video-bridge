import { describe, it, expect } from 'vitest';
import { formatRow, rowWidth } from './table.js';

describe('formatRow', () => {
  it('pads each value to its column width and joins with a single space', () => {
    // The bug this replaces: console.log('%-20s', v) does NOT pad. Node's
    // util.format has no width/flag syntax, so '%-20s' is not a specifier at
    // all — it is emitted literally and the value appended after the string.
    expect(formatRow(['ID', 'Description'], [6, 12])).toBe('ID     Description');
  });

  it('does not truncate a value wider than its column', () => {
    // Matches printf's %-Ns, which pads but never cuts. The row misaligns
    // rather than silently losing a camera id.
    expect(formatRow(['a-very-long-id', 'x'], [4, 4])).toBe('a-very-long-id x');
  });

  it('leaves no trailing whitespace on the final column', () => {
    const row = formatRow(['a', 'b'], [10, 10]);
    expect(row).toBe('a          b');
    expect(row).not.toMatch(/\s$/);
  });
});

describe('rowWidth', () => {
  it('counts the columns plus the single space between each pair', () => {
    // 6 + 1 + 12 === 19; the separator rule must match the header it sits
    // under, not a hardcoded guess.
    expect(rowWidth([6, 12])).toBe(19);
  });

  it('is the width of a row whose values exactly fill their columns', () => {
    const widths = [20, 20, 16, 10];
    const filled = widths.map((w) => 'x'.repeat(w));
    expect(rowWidth(widths)).toBe(formatRow(filled, widths).length);
  });
});
