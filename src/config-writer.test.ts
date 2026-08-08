import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { mergeGo2rtcYaml, mergeConfigYaml, mergeEnv } from './config-writer.js';

const STREAMS = [{ name: 'front', url: 'rtsp://u:p@${GO2RTC_BIND}:8561/s1' }];
const HOMEKIT = [{ name: 'front', pin: '123-45-678', displayName: 'Front', motionThreshold: 3.5 }];

const CAMERA = {
  id: '10000001-2050',
  name: 'front',
  quality: 'hd',
  localRtsp: { host: '192.168.1.20', port: 40001, listenPort: 8561 },
};

/** A file that has been paired — the state the writer must refuse. */
const PAIRED = `
homekit:
  front:
    pin: "111-22-333"
    device_private: aabbcc
    pairings:
      - client_id=X&client_public=Y&permissions=1
`;

describe('mergeGo2rtcYaml', () => {
  it('adds streams and homekit to a file that has neither', () => {
    const r = mergeGo2rtcYaml('rtsp:\n  listen: ":8554"\n', STREAMS, HOMEKIT);
    expect(r.refused).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(['streams.front', 'homekit.front']);

    const out = parse(r.text);
    expect(out.streams.front).toBe('rtsp://u:p@${GO2RTC_BIND}:8561/s1');
    expect(out.homekit.front).toEqual({
      pin: '123-45-678',
      name: 'Front',
      hksv: true,
      motion: 'detect',
      motion_threshold: 3.5,
    });
    // The pre-existing block must survive untouched.
    expect(out.rtsp.listen).toBe(':8554');
  });

  // 🔴 The guard that protects unrecoverable state. Mutation-tested below.
  it('REFUSES a file that already has pairings, and changes nothing', () => {
    const r = mergeGo2rtcYaml(PAIRED, STREAMS, HOMEKIT);
    expect(r.refused).toMatch(/pairings/i);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(PAIRED);
    expect(r.added).toEqual([]);
  });

  it('names the paired accessory in the refusal, so the user knows which', () => {
    expect(mergeGo2rtcYaml(PAIRED, STREAMS, HOMEKIT).refused).toContain('front');
  });

  // Positive control for the guard: same shape, no pairings -> it must NOT fire.
  // Without this, a guard that refused unconditionally would pass the test above.
  it('does NOT refuse when homekit exists but has no pairings', () => {
    const unpaired = 'homekit:\n  kitchen:\n    pin: "111-22-333"\n';
    const r = mergeGo2rtcYaml(unpaired, STREAMS, HOMEKIT);
    expect(r.refused).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(parse(r.text).homekit.kitchen.pin).toBe('111-22-333');
  });

  it('does NOT refuse when pairings exists but is empty', () => {
    const r = mergeGo2rtcYaml('homekit:\n  kitchen:\n    pairings: []\n', STREAMS, HOMEKIT);
    expect(r.refused).toBeUndefined();
  });

  it('skips a stream that already exists rather than overwriting it', () => {
    const existing = 'streams:\n  front: rtsp://ALREADY/there\n';
    const r = mergeGo2rtcYaml(existing, STREAMS, HOMEKIT);
    expect(r.skipped).toContain('streams.front');
    expect(r.added).not.toContain('streams.front');
    expect(parse(r.text).streams.front).toBe('rtsp://ALREADY/there');
  });

  it('never produces a duplicate top-level key', () => {
    const r = mergeGo2rtcYaml('streams:\n  kitchen: rtsp://x\n', STREAMS, HOMEKIT);
    const topLevel = r.text.split('\n').filter((l) => /^[a-z_]+:/.test(l));
    expect(topLevel.length).toBe(new Set(topLevel).size);
    // and both streams survive
    expect(Object.keys(parse(r.text).streams).sort()).toEqual(['front', 'kitchen']);
  });

  it('preserves comments — the file carries a credentials warning on purpose', () => {
    const existing = '# ⚠️ contains camera passwords — mode 600\nrtsp:\n  listen: ":8554"\n';
    const r = mergeGo2rtcYaml(existing, STREAMS, HOMEKIT);
    expect(r.text).toContain('⚠️ contains camera passwords');
  });

  it('refuses a file it cannot parse rather than rewriting it', () => {
    const broken = 'streams:\n  a: 1\n bad indent: [\n';
    const r = mergeGo2rtcYaml(broken, STREAMS, HOMEKIT);
    expect(r.refused).toBeDefined();
    expect(r.text).toBe(broken);
  });

  it('reports no change when everything is already present', () => {
    const first = mergeGo2rtcYaml('', STREAMS, HOMEKIT);
    const second = mergeGo2rtcYaml(first.text, STREAMS, HOMEKIT);
    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
    expect(second.text).toBe(first.text);
  });
});

describe('mergeConfigYaml', () => {
  it('adds a camera to an empty file', () => {
    const r = mergeConfigYaml('', [CAMERA]);
    expect(r.changed).toBe(true);
    const out = parse(r.text);
    expect(out.cameras).toHaveLength(1);
    expect(out.cameras[0]).toEqual({
      id: '10000001-2050',
      name: 'front',
      quality: 'hd',
      localRtsp: { host: '192.168.1.20', port: 40001, listenPort: 8561 },
    });
  });

  it('identifies an existing camera by id, not by name or position', () => {
    const existing = 'cameras:\n  - id: "10000001-2050"\n    name: "renamed-by-user"\n';
    const r = mergeConfigYaml(existing, [CAMERA]);
    expect(r.skipped).toEqual(['10000001-2050']);
    expect(r.changed).toBe(false);
    expect(parse(r.text).cameras[0].name).toBe('renamed-by-user');
  });

  it('appends alongside an unrelated existing camera', () => {
    const existing = 'cameras:\n  - id: "OTHER-1"\n    name: "kitchen"\n';
    const r = mergeConfigYaml(existing, [CAMERA]);
    expect(r.added).toEqual(['10000001-2050']);
    expect(parse(r.text).cameras.map((c: { id: string }) => c.id)).toEqual(['OTHER-1', '10000001-2050']);
  });

  it('omits path when it is the default, and includes it otherwise', () => {
    const withPath = { ...CAMERA, localRtsp: { ...CAMERA.localRtsp, path: '/s2' } };
    expect(parse(mergeConfigYaml('', [CAMERA]).text).cameras[0].localRtsp.path).toBeUndefined();
    expect(parse(mergeConfigYaml('', [withPath]).text).cameras[0].localRtsp.path).toBe('/s2');
  });
});

describe('mergeEnv', () => {
  it('appends a key that is absent', () => {
    const r = mergeEnv('EXISTING=1\n', 'ADC_BRIDGE_RTSP_PORTS', '8561-8563');
    expect(r.changed).toBe(true);
    expect(r.text).toBe('EXISTING=1\nADC_BRIDGE_RTSP_PORTS=8561-8563\n');
  });

  it('adds a missing trailing newline before appending', () => {
    expect(mergeEnv('EXISTING=1', 'K', 'v').text).toBe('EXISTING=1\nK=v\n');
  });

  it('is a no-op when the key already has the same value', () => {
    const existing = 'ADC_BRIDGE_RTSP_PORTS=8561-8563\n';
    const r = mergeEnv(existing, 'ADC_BRIDGE_RTSP_PORTS', '8561-8563');
    expect(r.changed).toBe(false);
    expect(r.skipped).toEqual(['ADC_BRIDGE_RTSP_PORTS']);
    expect(r.text).toBe(existing);
  });

  // The user may have chosen their port range deliberately; moving it silently
  // would break the published container ports against a config naming the old.
  it('REFUSES to rewrite a key that holds a different value', () => {
    const existing = 'ADC_BRIDGE_RTSP_PORTS=9000-9002\n';
    const r = mergeEnv(existing, 'ADC_BRIDGE_RTSP_PORTS', '8561-8563');
    expect(r.refused).toBeDefined();
    expect(r.refused).toContain('9000-9002');
    expect(r.text).toBe(existing);
  });
});
