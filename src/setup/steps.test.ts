import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pickBindAddress, parseComposeVersion, composeIsSupported, buildEnvAdditions,
  missingRequiredEnv, formatVerifyVerdict, REQUIRED_ENV_KEYS, mayRevealOnConflict,
} from './steps.js';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal });

describe('pickBindAddress', () => {
  it('takes the single private LAN address', () => {
    const r = pickBindAddress({ en0: [v4('192.168.7.42')], lo0: [v4('127.0.0.1', true)] });
    expect(r.address).toBe('192.168.7.42');
    expect(r.error).toBeUndefined();
  });

  /**
   * 🔴 docker0 is 172.17.0.1 — a private address, so every naive check passes it,
   * and it is exactly the one that cannot work under network_mode: host.
   */
  it('excludes docker and other virtual interfaces', () => {
    const r = pickBindAddress({
      docker0: [v4('172.17.0.1')], 'br-abc123': [v4('172.18.0.1')],
      veth99: [v4('10.9.9.9')], en0: [v4('192.168.7.42')],
    });
    expect(r.address).toBe('192.168.7.42');
  });

  // Positive control for the exclusion: without a real interface present it must
  // NOT fall back to docker0 — it must refuse.
  it('refuses rather than falling back to a virtual interface', () => {
    const r = pickBindAddress({ docker0: [v4('172.17.0.1')], lo0: [v4('127.0.0.1', true)] });
    expect(r.address).toBeUndefined();
    expect(r.error).toMatch(/no private IPv4/);
  });

  it('refuses to guess between several candidates, and names them', () => {
    const r = pickBindAddress({ en0: [v4('192.168.7.42')], en1: [v4('10.0.0.5')] });
    expect(r.address).toBeUndefined();
    expect(r.candidates.sort()).toEqual(['10.0.0.5', '192.168.7.42']);
    expect(r.error).toMatch(/SILENTLY/);
    expect(r.error).toMatch(/--bind-address/);
  });

  it('never returns loopback, even as a last resort', () => {
    const r = pickBindAddress({ lo0: [v4('127.0.0.1', true)] });
    expect(r.address).toBeUndefined();
  });

  it('ignores IPv6 and public addresses', () => {
    const r = pickBindAddress({
      en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, v4('8.8.8.8'), v4('192.168.1.5')],
    });
    expect(r.address).toBe('192.168.1.5');
  });

  it('accepts the numeric family Node <18 reports', () => {
    const r = pickBindAddress({ en0: [{ address: '192.168.1.5', family: 4, internal: false }] });
    expect(r.address).toBe('192.168.1.5');
  });

  it('treats one address on two interfaces as one candidate', () => {
    const r = pickBindAddress({ en0: [v4('192.168.7.42')], en1: [v4('192.168.7.42')] });
    expect(r.address).toBe('192.168.7.42');
  });
});

describe('parseComposeVersion', () => {
  it('parses both the v-prefixed and bare forms', () => {
    expect(parseComposeVersion('Docker Compose version v2.20.1')).toEqual({ major: 2, minor: 20, patch: 1 });
    expect(parseComposeVersion('docker-compose version 2.20.1, build abc')).toEqual({ major: 2, minor: 20, patch: 1 });
  });

  it('returns undefined when there is no version to find', () => {
    expect(parseComposeVersion('command not found')).toBeUndefined();
  });

  // ⚠️ The Synology binary is called docker-compose but IS v2. The name must
  // never be used to infer the major version.
  it('accepts v2 regardless of the binary name, and rejects v1', () => {
    expect(composeIsSupported(parseComposeVersion('docker-compose version v2.20.1'))).toBe(true);
    expect(composeIsSupported(parseComposeVersion('docker-compose version 1.29.2'))).toBe(false);
    expect(composeIsSupported(undefined)).toBe(false);
  });
});

describe('REQUIRED_ENV_KEYS', () => {
  /**
   * 🔴 Pins this list against the compose file itself. These two drifting apart
   * is what makes .env.example insufficient today — it lists none of the four
   * GO2RTC_* keys, so a user following it hits a compose error before any
   * container exists.
   */
  it('matches every ${VAR:?} guard in docker-compose.yml', () => {
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf-8');
    // ⚠️ [A-Z0-9_]+, not [A-Z_]+ — `GO2RTC` contains a digit, and the narrower
    // class silently matched only ADC_BRIDGE_BIND_ADDRESS. A pinning test whose
    // own extraction is too narrow reports a clean match against nothing.
    const guarded = new Set(
      [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]!),
    );
    expect([...guarded].sort()).toEqual([...REQUIRED_ENV_KEYS].sort());
  });

  // Positive control for the regex above: it must actually find the digit-bearing
  // names, not merely agree with a list that happens to be right.
  it('finds the digit-bearing GO2RTC keys in the compose file', () => {
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf-8');
    const guarded = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]!);
    expect(guarded).toContain('GO2RTC_API_PASSWORD');
    expect(guarded.filter((k) => k.startsWith('GO2RTC_'))).toHaveLength(4);
  });

  /**
   * ⚠️ `.env.example` IS complete today — this guards it staying that way when a
   * new `${VAR:?}` guard is added to compose. A missing key here means a user
   * who follows the example hits a compose error before any container exists.
   */
  it('is fully covered by .env.example', () => {
    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf-8');
    const declared = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
    // Positive control: the extraction must find digit-bearing names.
    expect(declared).toContain('GO2RTC_API_PASSWORD');
    expect([...REQUIRED_ENV_KEYS].filter((k) => !declared.has(k))).toEqual([]);
  });

  it('reports every missing or empty required key', () => {
    expect(missingRequiredEnv({})).toEqual([...REQUIRED_ENV_KEYS, 'ADC_USERNAME', 'ADC_PASSWORD']);
    // Empty is missing — compose's :? fires on empty as well as unset.
    expect(missingRequiredEnv({ ADC_BRIDGE_BIND_ADDRESS: '   ' })).toContain('ADC_BRIDGE_BIND_ADDRESS');
  });

  it('reports nothing when all are present', () => {
    const full = Object.fromEntries(
      [...REQUIRED_ENV_KEYS, 'ADC_USERNAME', 'ADC_PASSWORD'].map((k) => [k, 'x']),
    );
    expect(missingRequiredEnv(full)).toEqual([]);
  });
});

describe('buildEnvAdditions', () => {
  it('generates the four go2rtc credentials rather than prompting', () => {
    let n = 0;
    const out = Object.fromEntries(
      buildEnvAdditions({ bindAddress: '192.168.1.5', portRange: '8561-8563', secret: () => `s${++n}` }),
    );
    expect(out.ADC_BRIDGE_BIND_ADDRESS).toBe('192.168.1.5');
    expect(out.ADC_BRIDGE_RTSP_PORTS).toBe('8561-8563');
    expect(out.GO2RTC_API_PASSWORD).toBe('s1');
    expect(out.GO2RTC_RTSP_PASSWORD).toBe('s2');
    expect(out.GO2RTC_API_PASSWORD).not.toBe(out.GO2RTC_RTSP_PASSWORD);
  });

  it('omits the status port unless one is chosen, leaving compose its default', () => {
    const keys = buildEnvAdditions({ bindAddress: 'a', portRange: 'b', secret: () => 'x' }).map(([k]) => k);
    expect(keys).not.toContain('ADC_BRIDGE_STATUS_PORT');
  });

  /**
   * 🔴 Found by RE-RUNNING setup, not by a unit test. Generating a secret for a
   * key that already has one makes every re-run manufacture a conflict against
   * a perfectly good stored value — and the conflict message then echoed the
   * stored credential to stdout.
   */
  it('generates NOTHING for keys that already have a value', () => {
    let calls = 0;
    const out = buildEnvAdditions(
      { bindAddress: 'a', portRange: 'b', secret: () => `s${++calls}` },
      {
        ADC_BRIDGE_BIND_ADDRESS: 'a', ADC_BRIDGE_RTSP_PORTS: 'b',
        GO2RTC_API_USERNAME: 'u', GO2RTC_API_PASSWORD: 'kept',
        GO2RTC_RTSP_USERNAME: 'u', GO2RTC_RTSP_PASSWORD: 'kept2',
      },
    );
    expect(out).toEqual([]);
    expect(calls, 'no secret should be generated for an existing key').toBe(0);
  });

  it('fills only the gaps when the env is partial', () => {
    const out = Object.fromEntries(
      buildEnvAdditions({ bindAddress: 'a', portRange: 'b', secret: () => 'new' },
        { GO2RTC_API_PASSWORD: 'kept' }),
    );
    expect(out.GO2RTC_API_PASSWORD).toBeUndefined();
    expect(out.GO2RTC_RTSP_PASSWORD).toBe('new');
  });

  it('treats a whitespace-only value as absent', () => {
    const out = Object.fromEntries(
      buildEnvAdditions({ bindAddress: 'a', portRange: 'b', secret: () => 'new' },
        { GO2RTC_API_PASSWORD: '   ' }),
    );
    expect(out.GO2RTC_API_PASSWORD).toBe('new');
  });
});

describe('mayRevealOnConflict', () => {
  // Allowlist, not denylist — a denylist leaks any key nobody anticipated.
  it('permits operational values and refuses every credential', () => {
    expect(mayRevealOnConflict('ADC_BRIDGE_RTSP_PORTS')).toBe(true);
    expect(mayRevealOnConflict('ADC_BRIDGE_BIND_ADDRESS')).toBe(true);
    for (const k of ['GO2RTC_API_PASSWORD', 'GO2RTC_RTSP_PASSWORD', 'ADC_PASSWORD',
      'STATUS_PASSWORD', 'ADC_MOBILE_HAIKU', 'SOME_FUTURE_TOKEN']) {
      expect(mayRevealOnConflict(k), `${k} must not be revealed`).toBe(false);
    }
  });
});

describe('formatVerifyVerdict', () => {
  it('is a go when nothing blocks', () => {
    const r = formatVerifyVerdict({ blocking: [], warnings: ['w'], passed: ['p'] });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('0 blocking');
    expect(r.text).not.toMatch(/Not starting/);
  });

  it('is a no-go on any blocking finding, and says why it matters', () => {
    const r = formatVerifyVerdict({ blocking: ['dup key'], warnings: [], passed: [] });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/BLOCKING\s+dup key/);
    expect(r.text).toMatch(/Not starting anything/);
    expect(r.text).toMatch(/never records/);
  });
});
