/**
 * Minimal QR encoder — byte mode only, enough for a HomeKit `X-HM://` setup
 * payload (always 20 characters, so version 2 at EC level Q).
 *
 * Deliberately limited to **single-block** version/EC combinations. Multi-block
 * versions need codeword interleaving, and silently getting that wrong produces
 * a symbol that looks perfect and scans as garbage — a failure mode with no
 * signal short of pointing a phone at it. `pickVersion` throws rather than
 * guess.
 *
 * ⚠️ A structurally valid QR proves nothing about scannability. The only real
 * verification is a phone.
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

interface VersionSpec {
  version: number;
  ec: EcLevel;
  dataCodewords: number;
  ecCodewords: number;
}

/**
 * Single-block configurations only (ISO/IEC 18004 Table 9). Versions 1-2 are
 * single-block at every EC level; version 3 only at L and M.
 */
const SPECS: VersionSpec[] = [
  { version: 1, ec: 'H', dataCodewords: 9, ecCodewords: 17 },
  { version: 1, ec: 'Q', dataCodewords: 13, ecCodewords: 13 },
  { version: 1, ec: 'M', dataCodewords: 16, ecCodewords: 10 },
  { version: 1, ec: 'L', dataCodewords: 19, ecCodewords: 7 },
  { version: 2, ec: 'H', dataCodewords: 16, ecCodewords: 28 },
  { version: 2, ec: 'Q', dataCodewords: 22, ecCodewords: 22 },
  { version: 2, ec: 'M', dataCodewords: 28, ecCodewords: 16 },
  { version: 2, ec: 'L', dataCodewords: 34, ecCodewords: 10 },
  { version: 3, ec: 'M', dataCodewords: 44, ecCodewords: 26 },
  { version: 3, ec: 'L', dataCodewords: 55, ecCodewords: 15 },
];

/** EC level bits used in the format information field. */
const EC_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const MASK_FUNCTIONS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ---- GF(256) ---------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR's primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    // Coefficients are highest-degree-first. Multiplying by (x + α^i): the `x`
    // term keeps index j, the constant term lands at j+1. Swapping these two
    // yields a polynomial with the wrong roots — the codewords still look like
    // plausible bytes, so nothing downstream complains and the symbol simply
    // fails every scanner.
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

export function reedSolomon(data: number[], ecCount: number): number[] {
  const gen = generatorPoly(ecCount);
  const rem = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) rem[i] = rem[i]! ^ mul(gen[i + 1]!, factor);
    }
  }
  return rem;
}

// ---- encoding --------------------------------------------------------------
export function pickVersion(byteLength: number, preferred: EcLevel = 'Q'): VersionSpec {
  // 4 bits mode + 8 bits length (versions 1-9) + payload.
  const needed = Math.ceil((4 + 8 + byteLength * 8) / 8);
  const spec =
    SPECS.filter((s) => s.ec === preferred && s.dataCodewords >= needed).sort(
      (a, b) => a.version - b.version,
    )[0] ?? SPECS.filter((s) => s.dataCodewords >= needed).sort((a, b) => a.version - b.version)[0];
  if (!spec) {
    throw new Error(
      `payload of ${byteLength} bytes needs a multi-block QR version, which this encoder ` +
        'deliberately does not implement — codeword interleaving done wrong yields a symbol that ' +
        'looks valid and scans as garbage.',
    );
  }
  return spec;
}

export function buildCodewords(text: string, spec: VersionSpec): number[] {
  const bytes = [...Buffer.from(text, 'latin1')];
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // 8-bit count for versions 1-9
  for (const b of bytes) push(b, 8);

  const capacity = spec.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k++) byte = (byte << 1) | bits[i + k]!;
    data.push(byte);
  }
  // Alternating pad bytes, per the spec.
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < spec.dataCodewords; i++) data.push(PAD[i % 2]!);

  return [...data, ...reedSolomon(data, spec.ecCodewords)];
}

// ---- matrix ----------------------------------------------------------------
type Grid = Array<Array<number | null>>;

function placeFunctionPatterns(grid: Grid, size: number, version: number): boolean[][] {
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, v: number) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r]![c] = v;
    reserved[r]![c] = true;
  };

  const finder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(top + r, left + c, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  if (version >= 2) {
    // Versions 2-6 carry exactly one alignment pattern, at (size-7, size-7).
    const centre = size - 7;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        set(centre + r, centre + c, dark ? 1 : 0);
      }
    }
  }

  set(size - 8, 8, 1); // the always-dark module

  // Reserve the format information areas without filling them yet.
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8]![i]) reserved[8]![i] = true;
    if (!reserved[i]![8]) reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }

  return reserved;
}

function placeData(grid: Grid, reserved: boolean[][], size: number, codewords: number[]): void {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // 🔴 `right` itself must move to 5, not a local copy. Skipping the timing
    // column via `const rightCol = right === 6 ? 5 : right` leaves `right` at 6,
    // so the next step lands on 4 and column 4 is visited TWICE — a symbol that
    // is structurally perfect and decodes to nothing.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue;
        grid[row]![col] = index < bits.length ? bits[index]! : 0;
        index++;
      }
    }
    upward = !upward;
  }
}

/** BCH(15,5) format information, XORed with the spec's 0x5412 mask. */
export function formatBits(ec: EcLevel, mask: number): number {
  const data = (EC_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function placeFormat(grid: Grid, size: number, ec: EcLevel, mask: number): void {
  const bits = formatBits(ec, mask);
  const bit = (i: number) => (bits >> i) & 1;

  // 🔴 Rows and columns here are easy to transpose, and doing so costs nothing
  // visible: the symbol looks perfect, every function pattern is correct, and
  // an encoder/decoder pair that share the mistake round-trip cleanly. Only an
  // independent scanner sees it. The reference implementation's
  // `setFunctionModule(8, i, ...)` is (x=8, y=i) — COLUMN 8, ROW i.
  for (let i = 0; i <= 5; i++) grid[i]![8] = bit(i);
  grid[7]![8] = bit(6);
  grid[8]![8] = bit(7);
  grid[8]![7] = bit(8);
  for (let i = 9; i <= 14; i++) grid[8]![14 - i] = bit(i);

  for (let i = 0; i <= 7; i++) grid[8]![size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) grid[size - 15 + i]![8] = bit(i);
}

function applyMask(grid: Grid, reserved: boolean[][], size: number, mask: number): Grid {
  const fn = MASK_FUNCTIONS[mask]!;
  const out: Grid = grid.map((row) => [...row]);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r]![c]) continue;
      if (fn(r, c)) out[r]![c] = (out[r]![c] ?? 0) ^ 1;
    }
  }
  return out;
}

/** ISO/IEC 18004 penalty rules, used to choose the mask. */
function penalty(grid: Grid, size: number): number {
  const at = (r: number, c: number) => grid[r]![c] ?? 0;
  let score = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // N1 — runs of five or more
      for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
        if (c + dc * 4 >= size && dc) continue;
        if (r + dr * 4 >= size && dr) continue;
        let run = 1;
        while (
          r + dr * run < size &&
          c + dc * run < size &&
          at(r + dr * run, c + dc * run) === at(r, c)
        )
          run++;
        const prevR = r - dr;
        const prevC = c - dc;
        const startsRun = prevR < 0 || prevC < 0 || at(prevR, prevC) !== at(r, c);
        if (startsRun && run >= 5) score += 3 + (run - 5);
      }
      // N2 — 2x2 blocks of one colour
      if (r + 1 < size && c + 1 < size) {
        const v = at(r, c);
        if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
      }
    }
  }

  // N3 — the 1:1:3:1:1 finder-like pattern with four light modules beside it
  const PATTERN = [1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (i: number) => number, start: number, len: number) => {
    for (let i = 0; i < PATTERN.length; i++) if (get(start + i) !== PATTERN[i]) return false;
    const before = Array.from({ length: 4 }, (_, k) => start - 1 - k).every(
      (i) => i < 0 || get(i) === 0,
    );
    const after = Array.from({ length: 4 }, (_, k) => start + PATTERN.length + k).every(
      (i) => i >= len || get(i) === 0,
    );
    return before || after;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + PATTERN.length <= size; j++) {
      if (matches((k) => at(i, k), j, size)) score += 40;
      if (matches((k) => at(k, i), j, size)) score += 40;
    }
  }

  // N4 — deviation from an even balance of dark and light
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += at(r, c);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

export interface QrSymbol {
  size: number;
  version: number;
  ec: EcLevel;
  mask: number;
  /** `modules[row][col]`, 1 = dark. */
  modules: number[][];
}

export function encodeQr(text: string, preferred: EcLevel = 'Q', forceMask?: number): QrSymbol {
  const spec = pickVersion(Buffer.byteLength(text, 'latin1'), preferred);
  const size = spec.version * 4 + 17;
  const codewords = buildCodewords(text, spec);

  const base: Grid = Array.from({ length: size }, () => new Array<number | null>(size).fill(null));
  const reserved = placeFunctionPatterns(base, size, spec.version);
  placeData(base, reserved, size, codewords);

  let best: QrSymbol | null = null;
  let bestScore = Infinity;
  for (let mask = forceMask ?? 0; mask < (forceMask !== undefined ? forceMask + 1 : 8); mask++) {
    const masked = applyMask(base, reserved, size, mask);
    placeFormat(masked, size, spec.ec, mask);
    const score = penalty(masked, size);
    if (score < bestScore) {
      bestScore = score;
      best = {
        size,
        version: spec.version,
        ec: spec.ec,
        mask,
        modules: masked.map((row) => row.map((v) => v ?? 0)),
      };
    }
  }
  return best!;
}

// ---- decoding --------------------------------------------------------------

/**
 * Read a symbol back. Used to round-trip the encoder in tests, and to inspect a
 * QR produced by some other tool — a label that decodes to bare digits rather
 * than an `X-HM://` URI is the failure this whole module exists to prevent.
 *
 * Single-block versions only, matching `encodeQr`. No error correction is
 * applied: a clean generated symbol needs none, and a damaged one should fail
 * loudly rather than be silently repaired.
 */
export function decodeQr(modules: number[][]): { text: string; mask: number; ec: EcLevel } {
  const size = modules.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1) throw new Error(`not a QR matrix: ${size}x${size}`);

  const bits: number[] = [];
  // Mirror of placeFormat: bit i lives at (row i, col 8) for i<=5, etc.
  const pts: Array<[number, number]> = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  let raw = 0;
  pts.forEach(([r, c], i) => { raw |= modules[r]![c]! << i; });
  const format = raw ^ 0x5412;
  const ecBits = (format >> 13) & 3;
  const mask = (format >> 10) & 7;
  const ec = (Object.keys(EC_BITS) as EcLevel[]).find((k) => EC_BITS[k] === ecBits) ?? 'M';

  const grid: Grid = modules.map((row) => [...row]);
  const reserved = placeFunctionPatterns(
    Array.from({ length: size }, () => new Array<number | null>(size).fill(null)),
    size,
    version,
  );
  const maskFn = MASK_FUNCTIONS[mask]!;

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue;
        bits.push((grid[row]![col] ?? 0) ^ (maskFn(row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k]!;
    bytes.push(b);
  }

  const mode = bytes[0]! >> 4;
  if (mode !== 4) throw new Error(`not byte mode (mode indicator ${mode})`);
  const length = ((bytes[0]! & 0xf) << 4) | (bytes[1]! >> 4);
  let text = '';
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(((bytes[1 + i]! & 0xf) << 4) | (bytes[2 + i]! >> 4));
  }
  return { text, mask, ec };
}
