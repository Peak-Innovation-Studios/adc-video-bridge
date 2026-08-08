import type { VerifyResult } from '../verify-config.js';

/**
 * Pure decisions for `npm run setup`.
 *
 * 🔑 **Nothing here touches the filesystem, the network or `process`.** Same
 * split as `config-writer.ts` / `config-writer-fs.ts`, for the same reason: the
 * parts that can be wrong in a costly way — picking the wrong bind address,
 * declaring a config safe to deploy — are decisions, and a decision that takes
 * only data can be tested exhaustively without Docker or a live account.
 */

/**
 * 🔴 The five keys `docker-compose.yml` guards with `${VAR:?}`. Compose refuses
 * to start if any is unset **or empty**, and the failure arrives as a compose
 * error before a container exists — nothing in the bridge's own logs.
 *
 * ⚠️ Derived from the compose file on 2026-08-08 and pinned by a test that
 * re-reads it, because these two lists silently drifting apart is exactly the
 * gap that makes `.env.example` insufficient today.
 */
export const REQUIRED_ENV_KEYS = [
  'ADC_BRIDGE_BIND_ADDRESS',
  'GO2RTC_API_USERNAME',
  'GO2RTC_API_PASSWORD',
  'GO2RTC_RTSP_USERNAME',
  'GO2RTC_RTSP_PASSWORD',
] as const;

/** Keys the bridge itself needs, beyond what compose enforces. */
export const REQUIRED_BRIDGE_KEYS = ['ADC_USERNAME', 'ADC_PASSWORD'] as const;

export function missingRequiredEnv(env: Record<string, string>): string[] {
  return [...REQUIRED_ENV_KEYS, ...REQUIRED_BRIDGE_KEYS].filter((k) => !env[k]?.trim());
}

export interface IfaceInfo {
  address: string;
  /** Node <18 reports a number here, >=18 a string. Both are handled. */
  family: string | number;
  internal: boolean;
}

export interface BindAddressChoice {
  address?: string;
  candidates: string[];
  error?: string;
}

/**
 * Virtual interfaces that are never the host's LAN address.
 *
 * 🔴 `docker0` matters most: it is `172.17.0.1`, which IS in a private range and
 * therefore passes every naive check — while being precisely the address that
 * cannot work, since go2rtc runs on `network_mode: host`.
 */
const VIRTUAL = /^(lo|docker|br-|veth|virbr|utun|tun|tap|awdl|llw|bridge\d)/i;

const isPrivateV4 = (ip: string): boolean => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
};

/**
 * Choose the host's real LAN address for `ADC_BRIDGE_BIND_ADDRESS`.
 *
 * 🔴 **Refuses to guess between several.** Getting this wrong does not error:
 * `SETUP.md` records that a mismatched address leaves the stream "simply
 * offline" with nothing logged anywhere. One candidate is an answer; two are a
 * question for the user.
 *
 * ⚠️ Loopback is rejected outright rather than used as a fallback — the
 * two-container split makes `127.0.0.1` unreachable from the bridge, and a
 * silent fallback would produce exactly the undiagnosable state above.
 */
export function pickBindAddress(
  interfaces: Record<string, IfaceInfo[] | undefined>,
): BindAddressChoice {
  const candidates: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos || VIRTUAL.test(name)) continue;
    for (const i of infos) {
      const v4 = i.family === 'IPv4' || i.family === 4;
      if (v4 && !i.internal && isPrivateV4(i.address)) candidates.push(i.address);
    }
  }
  const unique = [...new Set(candidates)];

  if (unique.length === 0) {
    return {
      candidates: [],
      error:
        'no private IPv4 LAN address found. go2rtc runs on network_mode: host and the bridge ' +
        'reaches it over the LAN, so 127.0.0.1 cannot work. Pass --bind-address <ip> explicitly.',
    };
  }
  if (unique.length > 1) {
    return {
      candidates: unique,
      error:
        `several LAN addresses found (${unique.join(', ')}) and picking the wrong one fails ` +
        'SILENTLY — the stream reports offline with nothing logged. Pass --bind-address <ip>.',
    };
  }
  return { address: unique[0]!, candidates: unique };
}

export interface ComposeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `docker compose version` output. Accepts `v2.20.1` and `2.20.1`. */
export function parseComposeVersion(stdout: string): ComposeVersion | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Compose v2 is required: the `${VAR:?message}` guards this project relies on
 * are a v2 feature, and v1 silently substitutes an empty string instead.
 * ⚠️ The Synology binary is named `docker-compose` but IS v2 — never infer the
 * major version from the command name.
 */
export const composeIsSupported = (v: ComposeVersion | undefined): boolean => !!v && v.major >= 2;

export interface EnvPlan {
  bindAddress: string;
  portRange: string;
  statusPort?: number;
  /** Injected so the plan is deterministic under test. */
  secret: () => string;
}

/**
 * The `.env` entries setup adds, in the order a human would want to read them.
 *
 * 🔑 The four go2rtc values are GENERATED, not prompted. They protect a LAN
 * endpoint, nothing outside chooses them, and asking a user to invent four
 * passwords during setup reliably produces four weak ones.
 *
 * 🔴 **A key that already has a value is SKIPPED, and no secret is generated
 * for it.** Generating one anyway makes every re-run produce a fresh random
 * value that then "conflicts" with the perfectly good stored one — noise at
 * best, and at worst a conflict message that echoes the existing credential.
 * Neither value would be "right"; both are random. Found by re-running setup,
 * not by a unit test.
 */
export function buildEnvAdditions(
  plan: EnvPlan,
  existing: Record<string, string> = {},
): Array<[string, string]> {
  const has = (k: string) => !!existing[k]?.trim();
  const out: Array<[string, string]> = [];
  const add = (k: string, v: () => string) => {
    if (!has(k)) out.push([k, v()]);
  };

  add('ADC_BRIDGE_BIND_ADDRESS', () => plan.bindAddress);
  add('ADC_BRIDGE_RTSP_PORTS', () => plan.portRange);
  add('GO2RTC_API_USERNAME', () => 'go2rtc');
  add('GO2RTC_API_PASSWORD', plan.secret);
  add('GO2RTC_RTSP_USERNAME', () => 'go2rtc');
  add('GO2RTC_RTSP_PASSWORD', plan.secret);
  if (plan.statusPort !== undefined) add('ADC_BRIDGE_STATUS_PORT', () => String(plan.statusPort));
  return out;
}

/**
 * Keys whose conflicting value is safe to show in a message.
 * ⚠️ Allowlist, deliberately — a denylist would leak any key nobody anticipated.
 */
const SHOWABLE_ON_CONFLICT = new Set([
  'ADC_BRIDGE_BIND_ADDRESS', 'ADC_BRIDGE_RTSP_PORTS', 'ADC_BRIDGE_STATUS_PORT',
  'ADC_BRIDGE_UID', 'ADC_BRIDGE_GID', 'LOG_LEVEL',
]);

export const mayRevealOnConflict = (key: string): boolean => SHOWABLE_ON_CONFLICT.has(key);

/**
 * Turn a `verifyConfigs` result into a go / no-go.
 *
 * 🔴 **Blocking findings stop the deploy.** `verify-config.ts` catches duplicate
 * YAML keys, `listenPort` collisions and `motion: api` with no rule — and every
 * one of those presents identically once running: a paired accessory that never
 * records, with no error anywhere. Failing before a container starts is the
 * whole point of running it here.
 */
export function formatVerifyVerdict(r: VerifyResult): { ok: boolean; text: string } {
  const lines: string[] = [];
  for (const b of r.blocking) lines.push(`  BLOCKING  ${b}`);
  for (const w of r.warnings) lines.push(`  warning   ${w}`);
  lines.push(
    `\n  ${r.blocking.length} blocking, ${r.warnings.length} warnings, ${r.passed.length} checks passed`,
  );
  if (r.blocking.length > 0) {
    lines.push(
      '\n🔴 Not starting anything. Each blocking finding above produces a camera that pairs and ' +
        'then never records, with no error logged — far cheaper to fix now than to diagnose later.',
    );
  }
  return { ok: r.blocking.length === 0, text: lines.join('\n') };
}
