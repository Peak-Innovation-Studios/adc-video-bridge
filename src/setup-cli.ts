import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parse } from 'yaml';
import { mobileLogin, MobileApiError, type MobileCamera } from './mobile/mobile-api.js';
import { formatPin } from './homekit/setup-uri.js';
import { mergeConfigYaml, mergeGo2rtcYaml, mergeEnv, allocateListenPorts, portRangeCovering } from './config-writer.js';
import { applyMerge } from './config-writer-fs.js';
import { verifyConfigs, parseEnvFile } from './verify-config.js';
import {
  pickBindAddress, parseComposeVersion, composeIsSupported,
  buildEnvAdditions, missingRequiredEnv, formatVerifyVerdict, mayRevealOnConflict,
} from './setup/steps.js';

/**
 * `npm run setup` — one command from a clean checkout to paired cameras.
 *
 *   1 preflight   docker + compose v2; pick the host's LAN address
 *   2 credentials Alarm.com from env or a hidden prompt; go2rtc secrets GENERATED
 *   3 discover    ONE login, only if there is anything left to discover
 *   4 write       .env + config.yaml + go2rtc.yaml, 0600, backed up, never overwriting
 *   5 gate        verify:config — refuses to start anything on a blocking finding
 *   6 up          docker compose up --build -d
 *   7 pair        wait for health, then show the HomeKit codes
 *
 * 🔴 **This does NOT generate `docker-compose.yml`.** That file is maintained and
 * security-audited — read-only rootfs, dropped capabilities, `no-new-privileges`,
 * pinned digests, and a `network_mode: host` choice with the reasoning written
 * beside it. Every per-install value in it is already a `${VAR}` substitution, so
 * there is nothing to generate; a generated copy would be a second, unaudited
 * statement of the security posture that `docs/SECURITY_AUDIT.md` describes.
 *
 * 🔑 **Ordering is deliberate: preflight comes BEFORE the login.** Each run of
 * step 3 spends a real authentication attempt against an account Alarm.com can
 * lock, so nothing that can fail cheaply is allowed to fail after it.
 */

const DEFAULT_MOTION_THRESHOLD = 3.5;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const step = (n: number, title: string) => console.log(`\n[${n}/7] ${title}`);

/** 32 hex chars. Protects a LAN endpoint; nothing outside chooses it. */
const secret = (): string => randomBytes(16).toString('hex');

/**
 * Prompt, hiding input for secrets.
 *
 * ⚠️ Never accepts credentials as arguments — an argv value lands in shell
 * history and in `ps` output for every user on the box.
 */
function ask(query: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) {
    fail(`Cannot prompt for "${query.trim()}" — stdin is not a terminal. Set it in the environment.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stdout.write(query);
  }
  return new Promise((res) =>
    rl.question(hidden ? '' : query, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      res(a.trim());
    }),
  );
}

const envOrAsk = async (key: string, prompt: string, hidden = false): Promise<string> =>
  process.env[key]?.trim() || (await ask(prompt, hidden));

const readIfExists = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf-8') : '');

const streamName = (c: MobileCamera, i: number): string =>
  c.description.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `camera-${i + 1}`;

function suggestPin(): string {
  const INVALID = new Set(['00000000', '11111111', '22222222', '33333333', '44444444',
    '55555555', '66666666', '77777777', '88888888', '99999999', '12345678', '87654321']);
  for (;;) {
    const pin = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
    if (!INVALID.has(pin)) return pin;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (name: string) => argv.includes(name);
  const unknown = argv.filter((a, i) =>
    a.startsWith('--') && !['--bind-address', '--status-port', '--no-up', '--rediscover'].includes(a) &&
    argv[i - 1] !== '--bind-address' && argv[i - 1] !== '--status-port');
  if (unknown.length) {
    fail(`Unrecognised argument(s): ${unknown.join(', ')}\n` +
      'Usage: npm run setup [-- --bind-address <ip>] [--status-port <n>] [--no-up] [--rediscover]');
  }

  const CONFIG = resolve('config', 'config.yaml');
  const GO2RTC = resolve('config', 'go2rtc.yaml');
  const ENV = resolve('.env');

  // ---- 1. preflight -------------------------------------------------------
  step(1, 'Preflight');
  let composeCmd: string[] = ['docker', 'compose'];
  let versionOut = '';
  try {
    versionOut = execFileSync('docker', ['compose', 'version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    try {
      versionOut = execFileSync('docker-compose', ['version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      composeCmd = ['docker-compose'];
    } catch {
      versionOut = '';
    }
  }
  const version = parseComposeVersion(versionOut);
  if (!composeIsSupported(version)) {
    // Not fatal — the config half is still worth doing on a machine that will
    // never run the stack (the NAS deploys from a separate checkout anyway).
    console.log('  ⚠️  Docker Compose v2 not found. Will write configuration and stop before step 6.');
  } else {
    console.log(`  ✓  ${composeCmd.join(' ')} v${version!.major}.${version!.minor}.${version!.patch}`);
  }
  const canUp = composeIsSupported(version) && !has('--no-up');

  const existingEnv = parseEnvFile(readIfExists(ENV));
  let bindAddress = flag('--bind-address') ?? existingEnv.ADC_BRIDGE_BIND_ADDRESS;
  if (!bindAddress) {
    const choice = pickBindAddress(networkInterfaces() as never);
    if (!choice.address) fail(`Cannot choose a bind address: ${choice.error}`);
    bindAddress = choice.address;
  }
  console.log(`  ✓  bind address ${bindAddress}`);

  // ---- 2. what still needs discovering ------------------------------------
  // 🔑 The stored `listenPort` per camera is read, not just the count — it is
  // what `allocateListenPorts` reserves so a new camera cannot be handed a port
  // an existing one already binds.
  const existingCameras = (() => {
    try {
      const parsed = parse(readIfExists(CONFIG)) as { cameras?: unknown } | null;
      if (!Array.isArray(parsed?.cameras)) return [];
      return (parsed.cameras as Array<{ id?: unknown; localRtsp?: { listenPort?: unknown } }>)
        .map((c) => ({ id: String(c.id ?? ''), listenPort: Number(c.localRtsp?.listenPort ?? NaN) }))
        .filter((c) => c.id && Number.isInteger(c.listenPort));
    } catch { return []; }
  })();
  const alreadyConfigured = existingCameras.length > 0 && !has('--rediscover');

  let cameras: MobileCamera[] = [];
  if (alreadyConfigured) {
    step(2, 'Credentials — skipped');
    step(3, `Discovery — SKIPPED: config.yaml already has ${existingCameras.length} camera(s)`);
    console.log('  🔑 No login spent. Re-run with --rediscover to fetch again.');
  } else {
    step(2, 'Credentials');
    const username = await envOrAsk('ADC_USERNAME', '  Alarm.com email: ');
    const password = await envOrAsk('ADC_PASSWORD', '  Alarm.com password: ', true);
    const haiku = await envOrAsk('ADC_MOBILE_HAIKU', '  Haiku (from an app capture — see docs/MOBILE_API.md): ', true);
    if (!username || !password) fail('Alarm.com username and password are required.');
    if (!haiku) {
      fail('ADC_MOBILE_HAIKU is required — without it Alarm.com returns an empty body that looks\n' +
        'exactly like a rejected sign-in. Refusing to spend a login on a known-incomplete request.\n' +
        'See docs/MOBILE_API.md.');
    }
    const deviceUid = process.env.ADC_MOBILE_DEVICE_UID?.trim() || randomUUID().toUpperCase();
    const twoFactorId = process.env.ADC_MOBILE_TWO_FACTOR_ID?.trim();
    const hashCode = process.env.ADC_MOBILE_HASH_CODE?.trim();
    console.log('  ✓  credentials collected; go2rtc secrets will be generated');

    step(3, 'Discovering cameras (ONE login — never retried)');
    const result = await mobileLogin({
      username, password, deviceUid, haiku,
      ...(twoFactorId ? { twoFactorId } : {}),
      ...(hashCode ? { hashCode } : {}),
    });
    cameras = result.cameras.filter((c) => c.localRtsp);
    if (cameras.length === 0) fail('No camera on this account publishes a local RTSP endpoint.');
    for (const c of cameras) console.log(`  ✓  ${c.description} — ${c.model}`);
    if (!process.env.ADC_MOBILE_DEVICE_UID) {
      console.log(`\n  💡 Persist this so Alarm.com keeps treating you as the same device:`);
      console.log(`     ADC_MOBILE_DEVICE_UID=${deviceUid}`);
    }
  }

  // ---- 4. write -----------------------------------------------------------
  step(4, 'Writing configuration');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const say = (l: string) => console.log(l);
  // 🔴 Ports come from `allocateListenPorts`, never from array position — an
  // existing camera keeps its stored port and a new one gets the next free
  // number. The range must then COVER every port in use, existing included.
  const ports = allocateListenPorts(existingCameras, cameras.map((c) => c.cameraId));
  const allPorts = [...existingCameras.map((c) => c.listenPort), ...ports.values()];
  const portRange = alreadyConfigured
    ? existingEnv.ADC_BRIDGE_RTSP_PORTS || portRangeCovering(allPorts)
    : portRangeCovering(allPorts);

  const additions = buildEnvAdditions({
    bindAddress,
    portRange,
    secret,
    ...(flag('--status-port') ? { statusPort: Number(flag('--status-port')) } : {}),
  }, existingEnv);
  if (additions.length === 0) console.log('  ✓  .env — already complete');
  for (const [k, v] of additions) {
    applyMerge(ENV, (t) => mergeEnv(t, k, v, { revealOnConflict: mayRevealOnConflict(k) }),
      stamp, say, `.env ${k}`);
  }
  for (const k of ['ADC_USERNAME', 'ADC_PASSWORD'] as const) {
    if (process.env[k] && !existingEnv[k]) {
      applyMerge(ENV, (t) => mergeEnv(t, k, process.env[k]!), stamp, say, `.env ${k}`);
    }
  }

  if (cameras.length > 0) {
    const portOf = (c: MobileCamera) => ports.get(c.cameraId)!;
    applyMerge(CONFIG, (t) => mergeConfigYaml(t, cameras.map((c, i) => ({
      id: c.cameraId, name: streamName(c, i), quality: 'hd',
      localRtsp: { host: c.localRtsp!.host, port: c.localRtsp!.port, listenPort: portOf(c), path: c.localRtsp!.path },
    }))), stamp, say, 'config/config.yaml');

    applyMerge(GO2RTC, (t) => mergeGo2rtcYaml(t,
      cameras.map((c, i) => ({
        name: streamName(c, i),
        url: `rtsp://${c.localRtsp!.username}:${c.localRtsp!.password}@\${GO2RTC_BIND}:${portOf(c)}${c.localRtsp!.path}`,
      })),
      cameras.map((c, i) => ({
        name: streamName(c, i), pin: formatPin(suggestPin()),
        displayName: c.description, motionThreshold: DEFAULT_MOTION_THRESHOLD,
      })),
    ), stamp, say, 'config/go2rtc.yaml');
  }

  // ---- 5. gate ------------------------------------------------------------
  step(5, 'Verifying configuration');
  const env = parseEnvFile(readIfExists(ENV));
  const missing = missingRequiredEnv(env);
  if (missing.length > 0) {
    fail(`.env is missing required value(s): ${missing.join(', ')}\n` +
      'docker-compose.yml guards these with ${VAR:?}, so compose refuses to start and the error\n' +
      'arrives before any container exists — nothing appears in the bridge log.');
  }
  const verdict = formatVerifyVerdict(
    verifyConfigs({ configYaml: readIfExists(CONFIG), go2rtcYaml: readIfExists(GO2RTC), env }),
  );
  console.log(verdict.text);
  if (!verdict.ok) process.exit(1);

  // ---- 6. up --------------------------------------------------------------
  const upCommand = `${composeCmd.join(' ')} up --build -d`;
  if (!canUp) {
    step(6, 'Starting the stack — SKIPPED');
    console.log(`  Run it yourself (Synology and most Linux hosts need sudo):\n\n    ${upCommand}\n`);
  } else {
    step(6, `Starting the stack — ${upCommand}`);
    try {
      execFileSync(composeCmd[0]!, [...composeCmd.slice(1), 'up', '--build', '-d'], { stdio: 'inherit' });
    } catch {
      fail(`\`${upCommand}\` failed. If this is a permissions error, re-run it with sudo — an\n` +
        'unprivileged process cannot talk to the Docker socket on most hosts.\n' +
        'Everything up to this point is written and verified, so re-running setup is safe.');
    }
  }

  // ---- 7. pair ------------------------------------------------------------
  step(7, 'HomeKit pairing codes');
  const statusPort = env.ADC_BRIDGE_STATUS_PORT || '9090';
  const pairUrl = `http://${bindAddress}:${statusPort}/pair`;
  if (!canUp) {
    console.log(`  Once the stack is up, open:  ${pairUrl}`);
  } else {
    const auth = env.STATUS_USERNAME && env.STATUS_PASSWORD
      ? 'Basic ' + Buffer.from(`${env.STATUS_USERNAME}:${env.STATUS_PASSWORD}`).toString('base64')
      : undefined;
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      try {
        const res = await fetch(`http://${bindAddress}:${statusPort}/`, {
          ...(auth ? { headers: { Authorization: auth } } : {}),
          signal: AbortSignal.timeout(2000),
        });
        ready = res.ok || res.status === 401;
      } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    console.log(ready
      ? `  ✓  bridge is up. Open ${pairUrl} and scan one code per camera in the Home app.`
      : `  ⚠️  bridge did not answer on :${statusPort} within 60s.\n` +
        `     🔴 Port ${statusPort} refusing means the BRIDGE is down — check \`${composeCmd.join(' ')} logs bridge\`,\n` +
        '     not the relay ports. A config error and an unpublished port look identical from here.');
  }

  console.log('\n⚠️ motion_threshold is a property of the SCENE — expect to tune it per camera.');
  console.log('⚠️ config/go2rtc.yaml now holds camera passwords. Confirm it is mode 600 and never commit it.\n');
}

main().catch((err: unknown) => {
  if (err instanceof MobileApiError) fail(`Sign-in failed: ${err.message}`);
  throw err;
});
