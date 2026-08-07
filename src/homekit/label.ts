import { encodeQr, type QrSymbol } from './qr.js';
import { formatPin } from './setup-uri.js';

/**
 * A printable HomeKit pairing label: the setup QR with the setup code beneath
 * it in the `XXX-XX-XXX` form the Home app displays.
 *
 * 🔑 The QR must contain the `X-HM://` setup URI, **not** the digits. A QR
 * holding only the code is not a HomeKit payload — Home cannot tell what kind
 * of accessory it is and the camera pairing flow never starts. The printed
 * digits below are for the "More options…" path, where they ARE typed by hand.
 */
export interface LabelOptions {
  /** The `X-HM://…` setup URI. */
  uri: string;
  /** Setup code, with or without dashes. */
  pin: string;
  /** Pixels per QR module. */
  moduleSize?: number;
  /** Quiet zone in modules. The spec requires at least 4; less will not scan. */
  quietZone?: number;
}

const DEFAULTS = { moduleSize: 12, quietZone: 2 };

export function renderLabelSvg(options: LabelOptions): string {
  const moduleSize = options.moduleSize ?? DEFAULTS.moduleSize;
  const quiet = options.quietZone ?? DEFAULTS.quietZone;
  const symbol: QrSymbol = encodeQr(options.uri);

  const qrPixels = symbol.size * moduleSize;
  const pad = quiet * moduleSize;
  const width = qrPixels + pad * 2;
  const textBand = Math.round(moduleSize * 8.7);
  const height = width + textBand;

  // One <path> of horizontal runs, matching how such labels are usually drawn —
  // fewer nodes than a rect per module, and it prints identically.
  const runs: string[] = [];
  for (let row = 0; row < symbol.size; row++) {
    let col = 0;
    while (col < symbol.size) {
      if (symbol.modules[row]![col] !== 1) {
        col++;
        continue;
      }
      let run = 0;
      while (col + run < symbol.size && symbol.modules[row]![col + run] === 1) run++;
      const x = (col * moduleSize).toFixed(3);
      const y = (row * moduleSize).toFixed(3);
      const w = (run * moduleSize).toFixed(3);
      const h = moduleSize.toFixed(3);
      runs.push(`M${x},${y}h${w}v${h}h-${w}z`);
      col += run;
    }
  }

  const fontSize = Math.round(moduleSize * 3.8);
  const baseline = width + Math.round(textBand * 0.72);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `  <rect width="${width}" height="${height}" rx="${Math.round(moduleSize * 1.7)}" fill="#FFFFFF"/>`,
    `  <g transform="translate(${pad},${pad})">`,
    `    <path d="${runs.join('')}" fill="#000000" shape-rendering="crispEdges"/>`,
    '  </g>',
    `  <text x="${(width / 2).toFixed(1)}" y="${baseline}"`,
    '        text-anchor="middle" fill="#000000"',
    '        font-family="Helvetica Neue, Helvetica, Arial, sans-serif"',
    `        font-size="${fontSize}" font-weight="500"`,
    `        letter-spacing="2">${formatPin(options.pin)}</text>`,
    '</svg>',
    '',
  ].join('\n');
}
