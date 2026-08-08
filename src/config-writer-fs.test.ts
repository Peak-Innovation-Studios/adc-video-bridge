import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMerge } from './config-writer-fs.js';
import { mergeGo2rtcYaml } from './config-writer.js';

/**
 * 🔑 These run against a REAL temporary directory rather than a mocked `fs`.
 * The bugs worth catching here are file-mode and backup-ordering bugs, and a
 * mock cannot have them — it would report success for code that leaves a
 * world-readable copy of the camera passwords on disk.
 */

const STREAMS = [{ name: 'front', url: 'rtsp://u:p@${GO2RTC_BIND}:8561/s1' }];
const HOMEKIT = [{ name: 'front', pin: '123-45-678', displayName: 'Front', motionThreshold: 3.5 }];
const merge = (t: string) => mergeGo2rtcYaml(t, STREAMS, HOMEKIT);

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-fs-'));
  file = join(dir, 'go2rtc.yaml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

describe('applyMerge', () => {
  it('creates a missing file at mode 0600', () => {
    const out = applyMerge(file, merge, 'STAMP');
    expect(out.written).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, 'utf-8')).toContain('front');
    // Nothing existed, so there is nothing to back up.
    expect(out.backup).toBeUndefined();
  });

  it('backs up an existing file before rewriting it, and the backup is 0600', () => {
    writeFileSync(file, 'rtsp:\n  listen: ":8554"\n');
    const out = applyMerge(file, merge, 'STAMP');
    expect(out.backup).toBe(`${file}.bak-STAMP`);
    // The backup holds the ORIGINAL, not the new content.
    expect(readFileSync(out.backup!, 'utf-8')).toBe('rtsp:\n  listen: ":8554"\n');
    expect(mode(out.backup!)).toBe(0o600);
  });

  // 🔴 writeFileSync's `mode` applies only on creation, so an existing file
  // with a loose mode would silently keep it. This is the regression guard.
  it('tightens an existing file that was left world-readable', () => {
    writeFileSync(file, 'rtsp:\n  listen: ":8554"\n');
    chmodSync(file, 0o644);
    expect(mode(file)).toBe(0o644);
    applyMerge(file, merge, 'STAMP');
    expect(mode(file)).toBe(0o600);
  });

  it('does not write, and does not back up, when the merge refuses', () => {
    const paired = 'homekit:\n  front:\n    pairings:\n      - client_id=X\n';
    writeFileSync(file, paired);
    const out = applyMerge(file, merge, 'STAMP');

    expect(out.written).toBe(false);
    expect(out.refused).toMatch(/pairings/i);
    expect(readFileSync(file, 'utf-8')).toBe(paired);
    expect(existsSync(`${file}.bak-STAMP`)).toBe(false);
  });

  it('is idempotent — a second run writes nothing and takes no backup', () => {
    applyMerge(file, merge, 'FIRST');
    const after = readFileSync(file, 'utf-8');

    const out = applyMerge(file, merge, 'SECOND');
    expect(out.written).toBe(true);
    expect(out.added).toEqual([]);
    expect(out.skipped).toEqual(['streams.front', 'homekit.front']);
    expect(readFileSync(file, 'utf-8')).toBe(after);
    expect(existsSync(`${file}.bak-SECOND`)).toBe(false);
  });

  it('reports what it did through the log callback', () => {
    const lines: string[] = [];
    applyMerge(file, merge, 'STAMP', (l) => lines.push(l), 'config/go2rtc.yaml');
    expect(lines.join('\n')).toContain('config/go2rtc.yaml');
    expect(lines.join('\n')).toContain('streams.front');
  });
});
