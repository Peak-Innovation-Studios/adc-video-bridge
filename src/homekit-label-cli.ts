import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { renderLabelSvg } from './homekit/label.js';
import {
  CATEGORY,
  CATEGORY_NAMES,
  calcSetupId,
  decodeSetupUri,
  formatPin,
  generateSetupUri,
} from './homekit/setup-uri.js';

/**
 * Emit a printable HomeKit pairing label per camera, deriving everything from
 * `config/go2rtc.yaml`.
 *
 *   npm run homekit:label -- /volume1/docker/adc-video-bridge ./labels
 *
 * 🔑 Nothing new goes into `go2rtc.yaml`. The setup ID is `sha512(stream name)`
 * and the category defaults to camera — both are derived by go2rtc itself and
 * are not config keys. The only input is `pin`.
 *
 * ⚠️ A setup QR only does anything for an UNPAIRED accessory. For one already
 * in the Home app these are documentation, useful the next time it is removed.
 */

const root = resolve(process.argv[2] ?? process.cwd());
const outDir = resolve(process.argv[3] ?? resolve(process.cwd(), 'labels'));
const configPath = resolve(root, 'config', 'go2rtc.yaml');

if (!existsSync(configPath)) {
  console.error(`Not found: ${configPath}`);
  console.error('Pass the deployment root, e.g. npm run homekit:label -- /volume1/docker/adc-video-bridge');
  process.exit(2);
}

const parsed = parse(readFileSync(configPath, 'utf-8'), { uniqueKeys: false }) as {
  homekit?: Record<string, { pin?: unknown; name?: unknown; category_id?: unknown; pairings?: unknown }>;
} | null;

const homekit = parsed?.homekit ?? {};
const names = Object.keys(homekit);
if (names.length === 0) {
  console.error('No `homekit:` blocks in go2rtc.yaml — nothing to label.');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const stream of names) {
  const block = homekit[stream]!;

  if (typeof block.pin === 'number') {
    console.error(`  ${stream}: pin parsed as a NUMBER — quote it or write it as XXX-XX-XXX.`);
    failures++;
    continue;
  }
  const pin = block.pin === undefined ? '' : String(block.pin);
  const digits = pin.replaceAll('-', '');
  if (digits.length !== 8) {
    console.error(`  ${stream}: pin must be 8 digits (got ${digits.length}) — skipped.`);
    failures++;
    continue;
  }

  const categoryRaw = block.category_id === undefined ? '' : String(block.category_id);
  const category =
    categoryRaw === 'doorbell'
      ? CATEGORY.doorbell
      : categoryRaw === 'bridge'
        ? CATEGORY.bridge
        : Number(categoryRaw) > 0
          ? Number(categoryRaw)
          : CATEGORY.camera;

  const setupId = calcSetupId(stream);
  const uri = generateSetupUri(category, digits, setupId);
  const file = resolve(outDir, `homekit-${stream}-${formatPin(digits)}.svg`);
  writeFileSync(file, renderLabelSvg({ uri, pin: digits }));

  // Round-trip so the printed label can never disagree with its own payload.
  const back = decodeSetupUri(uri);
  const ok = !('error' in back) && back.pin === formatPin(digits) && back.category === category;
  const paired = Array.isArray(block.pairings) && block.pairings.length > 0;

  console.log(`  ${stream}`);
  console.log(`    category : ${category} (${CATEGORY_NAMES[category] ?? 'custom'})`);
  console.log(`    setup id : ${setupId}  (derived from the stream name)`);
  console.log(`    round-trip: ${ok ? 'ok' : 'MISMATCH'}${paired ? '   ⚠️ already paired — remove it in the Home app before this QR does anything' : ''}`);
  console.log(`    -> ${file}`);
  if (!ok) failures++;
}

// ⚠️ The setup URI and the code itself are deliberately NOT printed: this output
// gets pasted into chats and tickets, and the code is the pairing secret. It is
// in the SVG, which is where it belongs.
console.log(`\n${names.length - failures}/${names.length} labels written to ${outDir}`);
process.exit(failures > 0 ? 1 : 0);
