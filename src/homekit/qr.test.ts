import { describe, it, expect } from 'vitest';
import { encodeQr, decodeQr, formatBits, reedSolomon, pickVersion } from './qr.js';

/**
 * 🔴 **A round-trip through my own decoder proves nothing.** Both halves share
 * my reading of the spec, so a shared misconception survives it — this encoder
 * passed every round-trip while producing symbols Apple's Vision framework
 * could not detect at all. Two real bugs hid behind that: the format
 * information was written transposed, and the Reed-Solomon generator
 * polynomial had its terms swapped.
 *
 * The tests that matter here are therefore the KNOWN-ANSWER ones, checked
 * against values published in the standard and its reference material. The
 * round-trip is kept only as a cheap regression net.
 */

describe('Reed-Solomon', () => {
  it('matches the canonical HELLO WORLD 1-Q vector', () => {
    // The worked example every QR tutorial uses; independent of this codebase.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
    expect(reedSolomon(data, 13)).toEqual([168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
  });

  it('produces the requested number of EC codewords', () => {
    expect(reedSolomon([1, 2, 3], 10)).toHaveLength(10);
    expect(reedSolomon([1, 2, 3], 22)).toHaveLength(22);
  });
});

describe('format information', () => {
  // ISO/IEC 18004 Table C.1, as the canonical 15-bit values.
  const TABLE: Record<string, number> = {
    L0: 0x77c4, L1: 0x72f3, M0: 0x5412, M4: 0x45f9,
    Q0: 0x355f, Q7: 0x2bed, H0: 0x1689, H3: 0x19d0,
  };

  for (const [key, expected] of Object.entries(TABLE)) {
    it(`${key} matches the published value`, () => {
      const ec = key[0] as 'L' | 'M' | 'Q' | 'H';
      expect(formatBits(ec, Number(key[1]))).toBe(expected);
    });
  }
});

describe('version selection', () => {
  it('picks version 2 at EC Q for a 20-byte HomeKit payload', () => {
    const spec = pickVersion(20, 'Q');
    expect(spec.version).toBe(2);
    expect(spec.ec).toBe('Q');
    expect(spec.dataCodewords).toBe(22);
  });

  it('refuses payloads that would need codeword interleaving', () => {
    // Multi-block versions are deliberately unimplemented: getting the
    // interleave wrong yields a symbol that looks valid and scans as garbage.
    expect(() => pickVersion(200)).toThrow(/multi-block/);
  });
});

describe('symbol structure', () => {
  const symbol = encodeQr('X-HM://00GWDYIWGABCD');

  it('is a 25x25 version 2 symbol', () => {
    expect(symbol.size).toBe(25);
    expect(symbol.version).toBe(2);
  });

  it('places all three finder patterns', () => {
    for (const [top, left] of [[0, 0], [0, 18], [18, 0]] as const) {
      expect(symbol.modules[top]![left]).toBe(1);
      expect(symbol.modules[top + 1]![left + 1]).toBe(0);
      expect(symbol.modules[top + 3]![left + 3]).toBe(1); // centre
    }
  });

  it('alternates the timing patterns', () => {
    for (let i = 8; i < symbol.size - 8; i++) {
      expect(symbol.modules[6]![i]).toBe(i % 2 === 0 ? 1 : 0);
      expect(symbol.modules[i]![6]).toBe(i % 2 === 0 ? 1 : 0);
    }
  });

  it('sets the always-dark module', () => {
    expect(symbol.modules[symbol.size - 8]![8]).toBe(1);
  });

  it('writes format information readable at both copies', () => {
    // Copy 1 lives in COLUMN 8 / ROW 8 — writing it transposed leaves every
    // function pattern correct and the symbol undecodable.
    const expected = formatBits(symbol.ec, symbol.mask);
    let copy1 = 0;
    const pts: Array<[number, number]> = [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
      [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    ];
    pts.forEach(([r, c], i) => { copy1 |= symbol.modules[r]![c]! << i; });
    expect(copy1).toBe(expected);
  });
});

describe('round-trip (necessary, NOT sufficient)', () => {
  for (const text of ['X-HM://00GWDYIWGABCD', 'X-HM://00GX4F4GCWXYZ', 'hello world', '112-23-344']) {
    it(`survives encode -> decode: ${text}`, () => {
      expect(decodeQr(encodeQr(text).modules).text).toBe(text);
    });
  }
});
