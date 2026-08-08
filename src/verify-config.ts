import { parse } from 'yaml';

/**
 * Cross-file consistency check for the three files that have to agree:
 * `config/config.yaml`, `config/go2rtc.yaml` and `.env`.
 *
 * 🔑 Nothing else checks the seams BETWEEN them, and every one of these
 * failures is silent — the bridge starts, go2rtc starts, and a camera simply
 * reads "offline" or never appears in the Home app. Each check below exists
 * because that exact mistake was made on the first real deployment:
 *
 * - a `listenPort` outside `ADC_BRIDGE_RTSP_PORTS` is never published, so the
 *   relay listens where go2rtc cannot reach it
 * - a `homekit:` block with no matching `streams:` entry is SKIPPED, with only
 *   a `warn` line from go2rtc
 * - a duplicate top-level key in `go2rtc.yaml` discards one block silently
 *
 * ⚠️ This does NOT replace `loadConfig()`, which is the authority on
 * `config.yaml` and fails loudly at startup. It covers what no single file's
 * own validation can see.
 */

export interface VerifyInput {
  configYaml: string;
  go2rtcYaml: string;
  env: Record<string, string>;
}

export interface VerifyResult {
  blocking: string[];
  warnings: string[];
  passed: string[];
}

/** HAP spec 4.2.1.2 invalid setup codes — go2rtc rejects these outright. */
const INSECURE_PINS = new Set([
  '00000000', '11111111', '22222222', '33333333', '44444444',
  '55555555', '66666666', '77777777', '88888888', '99999999',
  '12345678', '87654321',
]);

const TOP_LEVEL_KEYS = ['streams', 'homekit', 'rtsp', 'api', 'srtp', 'webrtc', 'log', 'ffmpeg'];

interface CameraLike {
  name?: unknown;
  localRtsp?: { host?: unknown; port?: unknown; listenPort?: unknown; path?: unknown };
}

export function verifyConfigs(input: VerifyInput): VerifyResult {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const passed: string[] = [];

  const bindAddress = input.env.ADC_BRIDGE_BIND_ADDRESS?.trim();
  const portRange = input.env.ADC_BRIDGE_RTSP_PORTS?.trim();

  // ---- .env ---------------------------------------------------------------
  let lo = 0;
  let hi = 0;
  if (!bindAddress) {
    blocking.push('ADC_BRIDGE_BIND_ADDRESS is not set — compose cannot bind any published port.');
  } else {
    passed.push(`ADC_BRIDGE_BIND_ADDRESS = ${bindAddress}`);
  }

  // ---- config.yaml --------------------------------------------------------
  let cameras: CameraLike[] = [];
  try {
    const parsed = parse(input.configYaml) as { cameras?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') {
      blocking.push('config.yaml did not parse to a mapping.');
    } else if (!Array.isArray(parsed.cameras)) {
      // The `cameras:` key itself is easy to lose when pasting a block, and the
      // result is a root-level sequence beside mappings — invalid YAML that
      // crash-loops the bridge with an error naming neither file nor cause.
      blocking.push('config.yaml has no `cameras:` list — check the key itself is present.');
    } else {
      cameras = parsed.cameras as CameraLike[];
      passed.push(`config.yaml parses — ${cameras.length} camera(s)`);
    }
  } catch (err) {
    blocking.push(`config.yaml does not parse: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }

  const relayCameras = cameras.filter((c) => c.localRtsp);
  const listenPorts = new Map<number, string>();

  if (relayCameras.length === 0) {
    if (cameras.length > 0) warnings.push('No camera has a `localRtsp` block — none use the local relay.');
    return finish();
  }

  if (!portRange) {
    blocking.push(
      'ADC_BRIDGE_RTSP_PORTS is not set, but cameras use `localRtsp` — no relay port is published, ' +
        'so every one of those streams reads offline with nothing logged.',
    );
  } else {
    const m = /^(\d+)(?:-(\d+))?$/.exec(portRange);
    if (!m) {
      blocking.push(`ADC_BRIDGE_RTSP_PORTS is malformed: ${portRange}`);
    } else {
      lo = Number(m[1]);
      hi = m[2] ? Number(m[2]) : lo;
      passed.push(`ADC_BRIDGE_RTSP_PORTS = ${portRange}`);
    }
  }

  for (const camera of relayCameras) {
    const name = String(camera.name ?? '(unnamed)');
    const port = camera.localRtsp?.listenPort;
    if (typeof port !== 'number') {
      blocking.push(`camera "${name}" has no numeric localRtsp.listenPort.`);
      continue;
    }
    const clash = listenPorts.get(port);
    if (clash) blocking.push(`cameras "${clash}" and "${name}" share listenPort ${port}.`);
    listenPorts.set(port, name);

    if (lo && (port < lo || port > hi)) {
      blocking.push(
        `camera "${name}" listenPort ${port} is OUTSIDE ADC_BRIDGE_RTSP_PORTS (${portRange}) — ` +
          'compose will not publish it, so go2rtc cannot reach the relay and the stream reads offline.',
      );
    } else if (lo) {
      passed.push(`camera "${name}" listenPort ${port} is published`);
    }
  }

  // ---- go2rtc.yaml --------------------------------------------------------
  for (const key of TOP_LEVEL_KEYS) {
    const count = (input.go2rtcYaml.match(new RegExp(`^${key}:`, 'gm')) ?? []).length;
    if (count > 1) {
      blocking.push(
        `go2rtc.yaml defines "${key}:" ${count} times — YAML forbids duplicate keys, so one block is ` +
          'silently discarded. Merge them into one.',
      );
    }
  }

  // 🔴 STRICT parse first. go2rtc's `yaml.Patch` unmarshals the file to read it
  // AND unmarshals its own output to validate, and yaml.v3 rejects duplicate
  // keys at ANY nesting level. So one duplicate anywhere silently disables
  // EVERY persisted write — HomeKit pairings, device keys, stream edits — while
  // go2rtc otherwise runs normally. Measured 2026-08-07: a duplicate `streams:`
  // cost a camera's pairing, which lived in memory only and vanished on
  // restart, presenting as an accessory stuck on "Connecting…".
  try {
    parse(input.go2rtcYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    blocking.push(
      `go2rtc.yaml is not strictly valid YAML (${message}) — go2rtc will still RUN, but every ` +
        'config write it attempts fails silently, so HomeKit pairings are lost on restart.',
    );
  }

  let go2rtc: Record<string, unknown> = {};
  try {
    // uniqueKeys:false so a duplicate key (reported above) still yields a
    // document, and the user gets every finding in one pass rather than one
    // per round trip.
    go2rtc = (parse(input.go2rtcYaml, { uniqueKeys: false }) as Record<string, unknown>) ?? {};
  } catch (err) {
    blocking.push(`go2rtc.yaml does not parse: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return finish();
  }

  const streams = (go2rtc.streams ?? {}) as Record<string, unknown>;
  const homekit = (go2rtc.homekit ?? {}) as Record<
    string,
    { pin?: unknown; hksv?: unknown; name?: unknown; pairings?: unknown; motion?: unknown; motion_threshold?: unknown }
  >;

  for (const camera of relayCameras) {
    const name = String(camera.name ?? '');
    const source = streams[name];
    if (source === undefined) {
      blocking.push(
        `stream "${name}" is missing from go2rtc.yaml — its homekit accessory is skipped with ` +
          `"[homekit] missing stream: ${name}" and never appears in the Home app.`,
      );
      continue;
    }
    if (typeof source !== 'string' || source === '') {
      blocking.push(`stream "${name}" has an empty source — go2rtc has nothing to pull, so the camera shows No Response.`);
      continue;
    }
    const m = /^rtsps?:\/\/([^:@/]*):[^@]*@([^:/]+):(\d+)(\/\S*)?$/.exec(source);
    if (!m) {
      blocking.push(`stream "${name}" is not a parseable rtsp URL with credentials.`);
      continue;
    }
    const [, user, host, portText, path] = m;
    const port = Number(portText);
    const expected = camera.localRtsp?.listenPort;
    if (port !== expected) {
      blocking.push(`stream "${name}" points at port ${port} but its relay listens on ${String(expected)}.`);
    } else {
      passed.push(`stream "${name}" -> :${port} matches its relay`);
    }
    if (!user) blocking.push(`stream "${name}" has no username — the camera will answer 401.`);
    if (host !== bindAddress && host !== '${GO2RTC_BIND}') {
      blocking.push(`stream "${name}" host is ${host}; expected ${bindAddress ?? '<bind address>'} or \${GO2RTC_BIND}.`);
    }
    const wantPath = String(camera.localRtsp?.path ?? '/s1');
    if ((path ?? '') !== wantPath) {
      warnings.push(`stream "${name}" path is ${path ?? '(none)'}; config.yaml expects ${wantPath}.`);
    }
  }

  // ---- homekit ------------------------------------------------------------
  const seenPins = new Map<string, string>();
  for (const [key, block] of Object.entries(homekit)) {
    if (!(key in streams)) {
      blocking.push(
        `homekit "${key}" has no matching stream — go2rtc logs "[homekit] missing stream: ${key}" and skips the accessory.`,
      );
      continue;
    }
    // 🔴 A pin that parsed as a NUMBER is a YAML problem, not a value problem:
    // go2rtc unmarshals `pin` into a string field, and an unquoted 8-digit pin
    // becomes an int. Worse, an unquoted pin with a LEADING ZERO silently loses
    // it — `09526946` parses as 9526946, seven digits. Quote it, or write it
    // with dashes, which can never be read as a number.
    if (typeof block?.pin === 'number') {
      blocking.push(
        `homekit "${key}" pin parsed as a NUMBER — quote it or write it as XXX-XX-XXX. ` +
          'go2rtc expects a string, and an unquoted leading zero is dropped silently.',
      );
      continue;
    }
    const raw = block?.pin === undefined ? '' : String(block.pin);
    if (!raw) {
      blocking.push(`homekit "${key}" has no pin — go2rtc falls back to its published default, leaving the accessory unprotected.`);
    } else {
      const digits = raw.replaceAll('-', '');
      if (digits.length !== 8) {
        blocking.push(`homekit "${key}" pin has ${digits.length} digits; it must be exactly 8.`);
      } else if (INSECURE_PINS.has(digits)) {
        blocking.push(`homekit "${key}" pin is on the HAP invalid-code list and go2rtc will reject it.`);
      } else {
        passed.push(`homekit "${key}" pin is valid`);
      }
      const clash = seenPins.get(digits);
      if (clash) blocking.push(`homekit "${key}" reuses the pin of "${clash}".`);
      else seenPins.set(digits, key);
    }
    // Motion mode. go2rtc accepts "api", "continuous", "detect" and "onvif"
    // (remapped to "api"). An ABSENT value behaves like "api": neither the
    // built-in detector nor continuous recording starts, so nothing ever
    // triggers unless something POSTs the motion API.
    const motion = block?.motion === undefined ? '' : String(block.motion);
    const VALID_MOTION = ['', 'api', 'continuous', 'detect', 'onvif'];
    if (!VALID_MOTION.includes(motion)) {
      blocking.push(
        `homekit "${key}" has motion: ${motion} — must be one of api, continuous, detect, onvif.`,
      );
    } else if (motion === '' || motion === 'api' || motion === 'onvif') {
      warnings.push(
        `homekit "${key}" uses motion: ${motion || 'api (unset)'} — recording then depends on an ` +
          'EXTERNAL trigger. For Alarm.com that means a notification RULE configured on their side; ' +
          'without one no motion event is ever emitted and HKSV never records. `motion: detect` ' +
          'removes that dependency by detecting motion from the video itself.',
      );
    }

    const threshold = block?.motion_threshold;
    if (threshold !== undefined && (typeof threshold !== 'number' || !(threshold > 0))) {
      blocking.push(`homekit "${key}" motion_threshold must be a positive number.`);
    }
    if (motion !== 'detect' && threshold !== undefined) {
      warnings.push(`homekit "${key}" sets motion_threshold but motion is not "detect" — it is ignored.`);
    }

    if (block?.hksv !== true) warnings.push(`homekit "${key}" does not set hksv: true — no Secure Video recording.`);
    if (!block?.name) warnings.push(`homekit "${key}" has no name.`);
    if (Array.isArray(block?.pairings) && block.pairings.length > 0) {
      passed.push(`homekit "${key}" is already paired — do not change its pin or device_id`);
    }
  }
  for (const camera of relayCameras) {
    const name = String(camera.name ?? '');
    if (name && !(name in homekit)) warnings.push(`camera "${name}" has no homekit block — it will not appear in the Home app.`);
  }

  // ---- listeners ----------------------------------------------------------
  const srtpListen = (go2rtc.srtp as { listen?: unknown } | undefined)?.listen;
  if (Object.keys(homekit).length > 0) {
    if (typeof srtpListen !== 'string' || srtpListen === '') {
      blocking.push(
        'srtp.listen is empty while homekit is configured — srtp.Server stays nil and EVERY HomeKit stream ' +
          'is refused, while accessories still pair and look healthy.',
      );
    } else {
      passed.push(`srtp.listen = ${srtpListen}`);
    }
  }
  for (const key of ['rtsp', 'api'] as const) {
    const listen = (go2rtc[key] as { listen?: unknown } | undefined)?.listen;
    if (typeof listen !== 'string' || listen === '') continue;
    if (/^:\d+$/.test(listen) || listen.startsWith('0.0.0.0')) {
      blocking.push(`${key}.listen = "${listen}" binds every interface — under network_mode: host there is no ports: mapping to confine it.`);
    } else {
      passed.push(`${key}.listen = ${listen}`);
    }
  }
  if ((go2rtc.api as { local_auth?: unknown } | undefined)?.local_auth !== true) {
    warnings.push('api.local_auth is not true — loopback requests skip authentication (SECURITY_AUDIT.md specifies true).');
  }

  return finish();

  function finish(): VerifyResult {
    return { blocking, warnings, passed };
  }
}

/** Parse a `.env` file well enough for the handful of keys this checks. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
