import { describe, it, expect } from 'vitest';
import { verifyConfigs, parseEnvFile } from './verify-config.js';

/**
 * Every "regression" case here is a mistake that was actually made on the first
 * real deployment, and every one of them was SILENT — the bridge started,
 * go2rtc started, and a camera simply read offline or never appeared in the
 * Home app. That is the whole reason this checker exists.
 */

const ENV = {
  ADC_BRIDGE_BIND_ADDRESS: '192.168.1.10',
  ADC_BRIDGE_RTSP_PORTS: '8561-8563',
};

const CONFIG = `
cameras:
  - id: "1014-2050"
    name: "front"
    quality: "hd"
    localRtsp: { host: "192.168.1.20", port: 40001, listenPort: 8561 }
  - id: "1014-2048"
    name: "backyard"
    quality: "hd"
    localRtsp: { host: "192.168.1.21", port: 40002, listenPort: 8562 }
`;

const GO2RTC = `
rtsp:
  listen: "\${GO2RTC_BIND}:8554"
api:
  listen: "\${GO2RTC_BIND}:1984"
  local_auth: true
srtp:
  listen: "\${GO2RTC_BIND}:8443"
streams:
  front: rtsp://camuser:AAAA1111BBBB2222@\${GO2RTC_BIND}:8561/s1
  backyard: rtsp://camuser:CCCC3333DDDD4444@\${GO2RTC_BIND}:8562/s1
homekit:
  front:
    pin: "37030214"
    name: "Front Camera"
    hksv: true
  backyard:
    pin: "70925212"
    name: "Backyard Camera"
    hksv: true
`;

const run = (over: Partial<{ configYaml: string; go2rtcYaml: string; env: Record<string, string> }> = {}) =>
  verifyConfigs({ configYaml: CONFIG, go2rtcYaml: GO2RTC, env: ENV, ...over });

describe('verifyConfigs — a correct deployment', () => {
  it('reports nothing blocking', () => {
    const result = run();
    expect(result.blocking).toEqual([]);
  });

  it('reports no warnings either, so a clean run is unambiguous', () => {
    expect(run().warnings).toEqual([]);
  });

  it('confirms the port, stream and pin checks actually ran', () => {
    const passed = run().passed.join('\n');
    expect(passed).toMatch(/listenPort 8561 is published/);
    expect(passed).toMatch(/stream "front" -> :8561 matches its relay/);
    expect(passed).toMatch(/homekit "front" pin is valid/);
  });
});

describe('verifyConfigs — the failures that actually happened', () => {
  it('catches a missing cameras: key', () => {
    // Pasting the camera block without its key yields a root-level sequence
    // beside mappings — invalid YAML that crash-looped the bridge.
    const headless = CONFIG.replace('cameras:\n', '');
    expect(run({ configYaml: headless }).blocking.join('\n')).toMatch(/cameras:|does not parse/);
  });

  it('catches a duplicate streams: block', () => {
    // Adding a second block instead of replacing the first: one silently wins.
    const doubled = GO2RTC.replace('streams:', 'streams:\n  front: ""\n\nstreams:');
    const blocking = run({ go2rtcYaml: doubled }).blocking.join('\n');
    expect(blocking).toMatch(/defines "streams:" 2 times/);
  });

  it('catches a duplicate key NESTED inside a block, not just at the top level', () => {
    // yaml.Patch rejects duplicates at any depth, and a rejected patch means
    // pairings never reach disk — the failure that cost a camera's pairing.
    const nested = GO2RTC.replace('    hksv: true\n  backyard:', '    hksv: true\n    hksv: true\n  backyard:');
    expect(run({ go2rtcYaml: nested }).blocking.join('\n')).toMatch(/not strictly valid YAML|pairings are lost/);
  });

  it('catches a homekit block with no matching stream', () => {
    const orphan = GO2RTC.replace('  backyard: rtsp://camuser:CCCC3333DDDD4444@${GO2RTC_BIND}:8562/s1\n', '');
    const blocking = run({ go2rtcYaml: orphan }).blocking.join('\n');
    expect(blocking).toMatch(/homekit "backyard" has no matching stream/);
    expect(blocking).toMatch(/missing stream: backyard/);
  });

  it('catches an empty stream source', () => {
    const empty = GO2RTC.replace('front: rtsp://camuser:AAAA1111BBBB2222@${GO2RTC_BIND}:8561/s1', 'front: ""');
    expect(run({ go2rtcYaml: empty }).blocking.join('\n')).toMatch(/stream "front" has an empty source/);
  });

  it('catches a listenPort outside ADC_BRIDGE_RTSP_PORTS', () => {
    const env = { ...ENV, ADC_BRIDGE_RTSP_PORTS: '8561-8561' };
    expect(run({ env }).blocking.join('\n')).toMatch(/listenPort 8562 is OUTSIDE/);
  });

  it('catches a missing ADC_BRIDGE_RTSP_PORTS entirely', () => {
    const { ADC_BRIDGE_RTSP_PORTS: _drop, ...env } = ENV;
    expect(run({ env }).blocking.join('\n')).toMatch(/ADC_BRIDGE_RTSP_PORTS is not set/);
  });

  it('catches a stream pointing at the wrong relay port', () => {
    const swapped = GO2RTC.replace('@${GO2RTC_BIND}:8561/s1', '@${GO2RTC_BIND}:8562/s1');
    expect(run({ go2rtcYaml: swapped }).blocking.join('\n')).toMatch(/points at port 8562 but its relay listens on 8561/);
  });
});

describe('verifyConfigs — HomeKit pin rules', () => {
  it('rejects a pin that is not 8 digits', () => {
    const short = GO2RTC.replace('"37030214"', '"1234567"');
    expect(run({ go2rtcYaml: short }).blocking.join('\n')).toMatch(/pin has 7 digits/);
  });

  it('accepts a dashed pin, because go2rtc strips the dashes', () => {
    const dashed = GO2RTC.replace('"37030214"', '"370-30-214"');
    expect(run({ go2rtcYaml: dashed }).blocking).toEqual([]);
  });

  it('rejects a pin on the HAP invalid-code list', () => {
    const insecure = GO2RTC.replace('"37030214"', '"12345678"');
    expect(run({ go2rtcYaml: insecure }).blocking.join('\n')).toMatch(/invalid-code list/);
  });

  it('rejects a reused pin', () => {
    const reused = GO2RTC.replace('"70925212"', '"37030214"');
    expect(run({ go2rtcYaml: reused }).blocking.join('\n')).toMatch(/reuses the pin/);
  });

  it('rejects a pin that YAML parsed as a number', () => {
    // Unquoted digits become an int, which go2rtc cannot unmarshal into its
    // string field — and an unquoted leading zero is dropped silently.
    const unquoted = GO2RTC.replace('pin: "37030214"', 'pin: 37030214');
    expect(run({ go2rtcYaml: unquoted }).blocking.join('\n')).toMatch(/parsed as a NUMBER/);
  });

  it('accepts a dashed unquoted pin, which YAML cannot read as a number', () => {
    const dashed = GO2RTC.replace('pin: "37030214"', 'pin: 370-30-214');
    expect(run({ go2rtcYaml: dashed }).blocking).toEqual([]);
  });

  it('rejects a missing pin, which would fall back to the published default', () => {
    const nopin = GO2RTC.replace('    pin: "37030214"\n', '');
    expect(run({ go2rtcYaml: nopin }).blocking.join('\n')).toMatch(/has no pin/);
  });
});

describe('verifyConfigs — listener safety', () => {
  it('catches an empty srtp.listen, which pairs fine and refuses every stream', () => {
    const nosrtp = GO2RTC.replace('  listen: "${GO2RTC_BIND}:8443"', '  listen: ""');
    expect(run({ go2rtcYaml: nosrtp }).blocking.join('\n')).toMatch(/srtp.listen is empty/);
  });

  it('catches a wildcard bind, which network_mode: host leaves unconfined', () => {
    const wild = GO2RTC.replace('rtsp:\n  listen: "${GO2RTC_BIND}:8554"', 'rtsp:\n  listen: ":8554"');
    expect(run({ go2rtcYaml: wild }).blocking.join('\n')).toMatch(/binds every interface/);
  });

  it('warns when api.local_auth is not true', () => {
    const off = GO2RTC.replace('local_auth: true', 'local_auth: false');
    expect(run({ go2rtcYaml: off }).warnings.join('\n')).toMatch(/local_auth is not true/);
  });
});

describe('parseEnvFile', () => {
  it('ignores comments and blank lines, and strips surrounding quotes', () => {
    const env = parseEnvFile('# comment\n\nA=1\nB="two"\nC=\'three\'\n');
    expect(env).toEqual({ A: '1', B: 'two', C: 'three' });
  });

  it('keeps = inside a value, which passwords routinely contain', () => {
    expect(parseEnvFile('PW=abc=def==').PW).toBe('abc=def==');
  });
});
