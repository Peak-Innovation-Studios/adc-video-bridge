import { randomUUID } from 'node:crypto';
import { mobileLogin, MobileApiError, type MobileCamera } from './mobile/mobile-api.js';
import { formatPin } from './homekit/setup-uri.js';

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

  console.log('\n' + '='.repeat(70));
  console.log('config/config.yaml');
  console.log('='.repeat(70) + '\n');
  console.log('cameras:');
  usable.forEach((c, i) => {
    const local = c.localRtsp!;
    console.log(`  # ${c.model} — ${c.description}`);
    console.log(`  - id: "${c.cameraId}"`);
    console.log(`    name: "${streamName(c, i)}"`);
    console.log(`    quality: "hd"`);
    console.log(`    localRtsp:`);
    console.log(`      host: "${local.host}"`);
    console.log(`      port: ${local.port}`);
    console.log(`      listenPort: ${RELAY_PORT_BASE + i}`);
    if (local.path !== '/s1') console.log(`      path: "${local.path}"`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('.env');
  console.log('='.repeat(70) + '\n');
  console.log(`ADC_BRIDGE_RTSP_PORTS=${RELAY_PORT_BASE}-${RELAY_PORT_BASE + usable.length - 1}`);

  console.log('\n' + '='.repeat(70));
  console.log('config/go2rtc.yaml   ⚠️ contains camera passwords — mode 600, never commit');
  console.log('='.repeat(70) + '\n');
  console.log('streams:');
  usable.forEach((c, i) => {
    const l = c.localRtsp!;
    console.log(`  ${streamName(c, i)}: rtsp://${l.username}:${l.password}@\${GO2RTC_BIND}:${RELAY_PORT_BASE + i}${l.path}`);
  });
  console.log('\nhomekit:');
  usable.forEach((c, i) => {
    console.log(`  ${streamName(c, i)}:`);
    console.log(`    pin: "${formatPin(suggestPin())}"`);
    console.log(`    name: "${c.description}"`);
    console.log(`    hksv: true`);
    console.log(`    motion: detect`);
    console.log(`    motion_threshold: 3.5`);
  });

  if (skipped.length > 0) {
    console.log(`\n⚠️ Omitted (no local endpoint): ${skipped.map((c) => c.description).join(', ')}`);
  }

  console.log('\nNext: paste the blocks above, then `npm run verify:config -- .` before deploying.');
  console.log('⚠️ motion_threshold is a property of the SCENE — expect to tune it per camera.\n');
}

main().catch((err: unknown) => {
  if (err instanceof MobileApiError) fail(`Sign-in failed: ${err.message}`);
  throw err;
});
