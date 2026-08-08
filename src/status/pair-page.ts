import { encodeQr } from '../homekit/qr.js';
import {
  CATEGORY,
  CATEGORY_NAMES,
  formatPin,
  generateSetupUri,
} from '../homekit/setup-uri.js';
import type { HomekitAccessory } from '../go2rtc/go2rtc-api.js';

/**
 * A scannable HomeKit pairing page, so getting cameras into the Home app needs
 * no CLI, no file editing and no transcribing of setup codes.
 *
 * 🔑 The codes come from go2rtc's API, never from `config/go2rtc.yaml` — the
 * bridge deliberately cannot read that file (`SECURITY_AUDIT.md`). go2rtc omits
 * `setup_code` once an accessory is paired, so **the window in which this page
 * can expose a pairing secret closes by itself**, without this code having to
 * remember to close it.
 *
 * ⚠️ It is still a secret while it is shown. This page inherits the status
 * endpoint's Basic auth and its LAN-only bind; do not expose either publicly.
 */

/** HTML-escape. Accessory names come from config and end up in markup. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Render a QR as an inline SVG — no external requests, no image files. */
export function qrSvg(text: string, moduleSize = 6, quietZone = 4): string {
  const symbol = encodeQr(text);
  const pad = quietZone * moduleSize;
  const size = symbol.size * moduleSize + pad * 2;

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
      runs.push(
        `M${col * moduleSize},${row * moduleSize}h${run * moduleSize}v${moduleSize}h-${run * moduleSize}z`,
      );
      col += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="HomeKit setup code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<g transform="translate(${pad},${pad})"><path d="${runs.join('')}" fill="#000" shape-rendering="crispEdges"/></g>` +
    '</svg>'
  );
}

function categoryOf(accessory: HomekitAccessory): number {
  const id = Number(accessory.categoryId);
  return Number.isInteger(id) && id > 0 ? id : CATEGORY.camera;
}

export function renderPairPage(accessories: HomekitAccessory[]): string {
  const cards = accessories
    .map((accessory) => {
      const title = escapeHtml(accessory.name || accessory.stream);
      const stream = escapeHtml(accessory.stream);

      // Paired accessories have no setup code — go2rtc stops sending it, and a
      // code would do nothing anyway until the accessory is removed in Home.
      if (accessory.paired > 0 || !accessory.setupCode || !accessory.setupId) {
        return `<article class="card paired">
  <h2>${title}</h2>
  <p class="stream">${stream}</p>
  <p class="state">Already paired${accessory.paired ? ` — ${accessory.paired} controller${accessory.paired === 1 ? '' : 's'}` : ''}</p>
  <p class="hint">Remove this camera in the Home app to pair it again; its code reappears here.</p>
</article>`;
      }

      const category = categoryOf(accessory);
      const uri = generateSetupUri(category, accessory.setupCode, accessory.setupId);
      return `<article class="card">
  <h2>${title}</h2>
  <p class="stream">${stream}</p>
  ${qrSvg(uri)}
  <p class="pin">${escapeHtml(formatPin(accessory.setupCode))}</p>
  <p class="hint">${escapeHtml(CATEGORY_NAMES[category] ?? 'Accessory')} · setup ID ${escapeHtml(accessory.setupId)}</p>
</article>`;
    })
    .join('\n');

  const empty = accessories.length === 0
    ? '<p class="none">No HomeKit accessories configured in go2rtc.</p>'
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair cameras with HomeKit</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 2rem 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .lede { margin: 0 0 2rem; opacity: .75; max-width: 34rem; }
  .grid { display: flex; flex-wrap: wrap; gap: 1.5rem; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 14px; padding: 1.25rem; width: 15rem; text-align: center; }
  .card.paired { opacity: .6; }
  h2 { font-size: 1.05rem; margin: 0 0 .1rem; }
  .stream { margin: 0 0 .9rem; font-size: .8rem; opacity: .6; font-family: ui-monospace, monospace; }
  svg { width: 100%; height: auto; border-radius: 8px; }
  .pin { font-size: 1.5rem; letter-spacing: .06em; font-weight: 600; margin: .7rem 0 .2rem; font-variant-numeric: tabular-nums; }
  .hint, .state { font-size: .78rem; opacity: .65; margin: .2rem 0 0; }
  .state { font-weight: 600; opacity: .8; }
  .none { opacity: .7; }
</style>
</head><body>
<h1>Pair cameras with HomeKit</h1>
<p class="lede">In the Home app choose <strong>Add Accessory</strong> and scan a code below.
Approve the “uncertified accessory” prompt. If scanning fails, tap
<strong>More options…</strong> and type the number instead.</p>
<div class="grid">
${cards}
</div>
${empty}
</body></html>`;
}
