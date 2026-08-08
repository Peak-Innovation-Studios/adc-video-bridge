import { describe, it, expect } from 'vitest';
import { renderPairPage, qrSvg } from './pair-page.js';
import { decodeQr } from '../homekit/qr.js';
import { decodeSetupUri } from '../homekit/setup-uri.js';
import type { HomekitAccessory } from '../go2rtc/go2rtc-api.js';

const unpaired: HomekitAccessory = {
  stream: 'backyard',
  name: 'Backyard Camera',
  deviceId: 'AA:BB:CC:DD:EE:FF',
  categoryId: '17',
  paired: 0,
  setupCode: '11223344',
  setupId: 'ABCD',
};

const paired: HomekitAccessory = {
  stream: 'driveway',
  name: 'Driveway Camera',
  deviceId: '11:22:33:44:55:66',
  categoryId: '17',
  paired: 2,
};

/** Pull the QR module matrix back out of the rendered inline SVG. */
function matrixFromSvg(svg: string, moduleSize = 6): number[][] {
  const d = /<path d="([^"]+)"/.exec(svg)![1]!;
  const cells = new Set<string>();
  let size = 0;
  for (const m of d.matchAll(/M(\d+),(\d+)h(\d+)v/g)) {
    const x = Math.round(Number(m[1]) / moduleSize);
    const y = Math.round(Number(m[2]) / moduleSize);
    const w = Math.round(Number(m[3]) / moduleSize);
    for (let i = 0; i < w; i++) {
      cells.add(`${y},${x + i}`);
      size = Math.max(size, y + 1, x + i + 1);
    }
  }
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => (cells.has(`${r},${c}`) ? 1 : 0)),
  );
}

describe('pairing page', () => {
  it('renders a QR whose payload is the correct setup URI', () => {
    const html = renderPairPage([unpaired]);
    const svg = /<svg[\s\S]*?<\/svg>/.exec(html)![0]!;

    const text = decodeQr(matrixFromSvg(svg)).text;
    const decoded = decodeSetupUri(text);

    expect(decoded).toMatchObject({
      category: 17,
      categoryName: 'IP Camera',
      pin: '112-23-344',
      setupId: 'ABCD',
    });
  });

  it('prints the pin in the form the Home app shows', () => {
    expect(renderPairPage([unpaired])).toContain('112-23-344');
  });

  /**
   * 🔑 The property that bounds the exposure: go2rtc stops sending a setup code
   * once its accessory is paired, so a paired camera has nothing to render and
   * this page cannot leak a code it was never given.
   */
  it('shows no code for a paired accessory', () => {
    const html = renderPairPage([paired]);
    expect(html).toContain('Already paired');
    expect(html).not.toContain('<svg');
  });

  it('does not leak an unpaired code onto a paired card', () => {
    const html = renderPairPage([paired, unpaired]);
    // exactly one QR — the unpaired one
    expect(html.match(/<svg/g)).toHaveLength(1);
  });

  it('escapes accessory names, which come from config and land in markup', () => {
    const html = renderPairPage([{ ...unpaired, name: '<script>alert(1)</script>' }]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles no accessories without breaking', () => {
    const html = renderPairPage([]);
    expect(html).toContain('No HomeKit accessories');
    expect(html).not.toContain('<svg');
  });

  it('embeds the QR with no external requests', () => {
    // The xmlns is a namespace identifier, not a fetch — check for things that
    // would actually load: images, stylesheets, scripts, CSS url().
    const svg = qrSvg('X-HM://00GWDYIWGABCD');
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/<image|xlink:href|<script|url\(/i);
  });

  it('serves a page with no external assets at all', () => {
    const html = renderPairPage([unpaired]);
    expect(html).not.toMatch(/<img|<script|<link|url\(|https?:\/\/(?!www\.w3\.org)/i);
  });
});
