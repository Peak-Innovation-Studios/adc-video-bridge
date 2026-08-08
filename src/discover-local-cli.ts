import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mobileLogin, MobileApiError, type MobileCamera } from './mobile/mobile-api.js';
import { formatPin } from './homekit/setup-uri.js';
import {
  mergeConfigYaml,
  mergeGo2rtcYaml,
  mergeEnv,
  type CameraEntry,
  type StreamEntry,
  type HomekitEntry,
} from './config-writer.js';
import { applyMerge } from './config-writer-fs.js';

/**
 * Discover cameras and their LOCAL RTSP endpoints, and print ready-to-paste
 * configuration for both files.
 *
 *   npm run discover:local
 *
 * 🔑 This is the step that makes the project adoptable. Everything it prints
 * previously had to be extracted by proxying the phone app.
 *
 * Credentials come from the environment, never arguments — an argument lands in
 * shell history and `ps`:
 *   ADC_USERNAME, ADC_PASSWORD           account login
 *   ADC_MOBILE_DEVICE_UID                stable per-install UUID (generated if unset)
 *   ADC_MOBILE_TWO_FACTOR_ID             trusted-device token, if the account uses 2FA
 *   ADC_MOBILE_HASH_CODE                 the app's HashCode, if the server requires it
 *
 * 🔴 Runs ONE login request and never retries — Alarm.com bans accounts that
 * poll authentication endpoints. If it fails, fix the input and run it again by
 * hand rather than looping.
 */

const RELAY_PORT_BASE = 8561;

/**
 * Starting `motion_threshold` for a scene nothing is known about.
 *
 * 🔑 Measured 2026-08-08 on this account: the idle noise floor topped out at
 * `ratio` 2.89 and real triggers ran 4.46-12.51, so anything in that gap works.
 * 3.5 sits at the sensitive end ON PURPOSE — for a new install, a threshold
 * slightly too LOW produces extra clips, which the user can see and then raise.
 * One slightly too HIGH produces nothing at all, which is indistinguishable
 * from a broken install. Prefer the failure the user can diagnose.
 */
const DEFAULT_MOTION_THRESHOLD = 3.5;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const streamName = (camera: MobileCamera, index: number): string => {
  const base = camera.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `camera-${index + 1}`;
};

/** 8 digits, avoiding the HAP invalid-code list. */
function suggestPin(): string {
  const INVALID = new Set([
    '00000000', '11111111', '22222222', '33333333', '44444444',
    '55555555', '66666666', '77777777', '88888888', '99999999',
    '12345678', '87654321',
  ]);
  for (;;) {
    const pin = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
    if (!INVALID.has(pin)) return pin;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => a !== '--write');
  if (unknown.length > 0) {
    fail(`Unrecognised argument(s): ${unknown.join(', ')}. Usage: npm run discover:local [-- --write]`);
  }
  const write = argv.includes('--write');

  const username = process.env.ADC_USERNAME?.trim();
  const password = process.env.ADC_PASSWORD?.trim();
  if (!username || !password) {
    fail('Set ADC_USERNAME and ADC_PASSWORD in the environment first.');
  }
  const deviceUid = process.env.ADC_MOBILE_DEVICE_UID?.trim() || randomUUID().toUpperCase();
  const twoFactorId = process.env.ADC_MOBILE_TWO_FACTOR_ID?.trim();
  const hashCode = process.env.ADC_MOBILE_HASH_CODE?.trim();

  const result = await mobileLogin({
    username,
    password,
    deviceUid,
    ...(twoFactorId ? { twoFactorId } : {}),
    ...(hashCode ? { hashCode } : {}),
  });

  const usable = result.cameras.filter((c) => c.localRtsp);
  const skipped = result.cameras.filter((c) => !c.localRtsp);

  console.log(`\nFound ${result.cameras.length} camera(s); ${usable.length} publish a local RTSP endpoint.\n`);
  for (const c of result.cameras) {
    const flags = [
      c.localRtsp ? 'local RTSP' : 'NO local endpoint',
      c.supportsWebRtc ? 'WebRTC ok' : 'WebRTC UNSUPPORTED — local RTSP is the only path',
    ].join(' · ');
    console.log(`  ${c.description} — ${c.model} (${c.cameraId})`);
    console.log(`      ${flags}`);
  }

  if (!process.env.ADC_MOBILE_DEVICE_UID) {
    console.log(`\n💡 Persist this so Alarm.com keeps treating you as the same device:`);
    console.log(`   ADC_MOBILE_DEVICE_UID=${deviceUid}`);
  }

  if (usable.length === 0) fail('No camera published a local RTSP endpoint.');

  // 🔑 Build every generated value ONCE, before deciding whether to print or
  // write. `suggestPin()` is random, so generating inside each output path
  // would print one pin and write a different one — and a pin that disagrees
  // with the paired accessory is unrecoverable without re-pairing.
  const cameras: CameraEntry[] = usable.map((c, i) => ({
    id: c.cameraId,
    name: streamName(c, i),
    quality: 'hd',
    localRtsp: {
      host: c.localRtsp!.host,
      port: c.localRtsp!.port,
      listenPort: RELAY_PORT_BASE + i,
      path: c.localRtsp!.path,
    },
  }));
  const streams: StreamEntry[] = usable.map((c, i) => ({
    name: streamName(c, i),
    url: `rtsp://${c.localRtsp!.username}:${c.localRtsp!.password}@\${GO2RTC_BIND}:${RELAY_PORT_BASE + i}${c.localRtsp!.path}`,
  }));
  const homekit: HomekitEntry[] = usable.map((c, i) => ({
    name: streamName(c, i),
    pin: formatPin(suggestPin()),
    displayName: c.description,
    motionThreshold: DEFAULT_MOTION_THRESHOLD,
  }));
  const portRange = `${RELAY_PORT_BASE}-${RELAY_PORT_BASE + usable.length - 1}`;

  const printConfigYaml = () => {
    console.log('\n' + '='.repeat(70));
    console.log('config/config.yaml');
    console.log('='.repeat(70) + '\n');
    console.log('cameras:');
    cameras.forEach((cam, i) => {
      console.log(`  # ${usable[i]!.model} — ${usable[i]!.description}`);
      console.log(`  - id: "${cam.id}"`);
      console.log(`    name: "${cam.name}"`);
      console.log(`    quality: "${cam.quality}"`);
      console.log(`    localRtsp:`);
      console.log(`      host: "${cam.localRtsp.host}"`);
      console.log(`      port: ${cam.localRtsp.port}`);
      console.log(`      listenPort: ${cam.localRtsp.listenPort}`);
      if (cam.localRtsp.path !== '/s1') console.log(`      path: "${cam.localRtsp.path}"`);
    });
  };

  const printEnv = () => {
    console.log('\n' + '='.repeat(70));
    console.log('.env');
    console.log('='.repeat(70) + '\n');
    console.log(`ADC_BRIDGE_RTSP_PORTS=${portRange}`);
  };

  const printGo2rtc = () => {
    console.log('\n' + '='.repeat(70));
    console.log('config/go2rtc.yaml   ⚠️ contains camera passwords — mode 600, never commit');
    console.log('='.repeat(70) + '\n');
    console.log('streams:');
    for (const s of streams) console.log(`  ${s.name}: ${s.url}`);
    console.log('\nhomekit:');
    for (const h of homekit) {
      console.log(`  ${h.name}:`);
      console.log(`    pin: "${h.pin}"`);
      console.log(`    name: "${h.displayName}"`);
      console.log(`    hksv: true`);
      console.log(`    motion: detect`);
      console.log(`    motion_threshold: ${h.motionThreshold}`);
    }
  };

  if (skipped.length > 0) {
    console.log(`\n⚠️ Omitted (no local endpoint): ${skipped.map((c) => c.description).join(', ')}`);
  }

  if (!write) {
    printConfigYaml();
    printEnv();
    printGo2rtc();
    console.log('\nNext: paste the blocks above, then `npm run verify:config -- .` before deploying.');
    console.log('💡 Or re-run with `--write` to merge them in place (backs up, never overwrites).');
  } else {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    console.log('\nWriting configuration:\n');

    const say = (line: string) => console.log(line);
    const results = [
      applyMerge(resolve('config', 'config.yaml'), (t) => mergeConfigYaml(t, cameras),
        stamp, say, 'config/config.yaml'),
      applyMerge(resolve('.env'), (t) => mergeEnv(t, 'ADC_BRIDGE_RTSP_PORTS', portRange),
        stamp, say, '.env'),
      applyMerge(resolve('config', 'go2rtc.yaml'), (t) => mergeGo2rtcYaml(t, streams, homekit),
        stamp, say, 'config/go2rtc.yaml'),
    ];

    // 🔑 Print ONLY the blocks that were refused. Printing all of them would
    // bury the one thing the user still has to act on, and the go2rtc block
    // carries camera passwords — do not put it on screen without cause.
    const refused = results.filter((r) => r.refused);
    if (refused.length > 0) {
      console.log(`\n⚠️  ${refused.length} file(s) left untouched. Merge these by hand:`);
      if (results[0]!.refused) printConfigYaml();
      if (results[1]!.refused) printEnv();
      if (results[2]!.refused) printGo2rtc();
    }

    console.log('\nNext: `npm run verify:config -- .` before deploying.');
    if (results[2]!.written) {
      console.log('⚠️ config/go2rtc.yaml now holds camera passwords — confirm it is mode 600 and gitignored.');
    }
  }
  console.log('⚠️ motion_threshold is a property of the SCENE — expect to tune it per camera.\n');
}

main().catch((err: unknown) => {
  if (err instanceof MobileApiError) fail(`Sign-in failed: ${err.message}`);
  throw err;
});
