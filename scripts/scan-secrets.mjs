#!/usr/bin/env node
/**
 * Block a commit that would publish a secret.
 *
 * 🔴 **This EXITS NON-ZERO. That is the whole point.** `docs/AGENT_HANDOFF.md`
 * records the failure this replaces: a fixture carrying a real camera username
 * was committed while a scan printed the finding and the commit proceeded
 * anyway. A check that reports without blocking is not a check.
 *
 * 🔑 **Scans ADDED lines in the staged diff, not the working tree.** The repo
 * already contains real values in committed history (see the baton), so a
 * whole-tree scan would fail every commit and be disabled within a day. Scoping
 * to added lines means existing content is left alone while nothing new spreads.
 *
 * Usage:
 *   node scripts/scan-secrets.mjs            # staged diff (pre-commit hook)
 *   node scripts/scan-secrets.mjs --range A..B
 *   node scripts/scan-secrets.mjs --stdin    # read a diff or text on stdin
 *
 * Escape hatch, deliberate and reviewable: put `leak-scan-ok` in a comment on
 * the same line. Use it for synthetic fixtures, never to silence a real value.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Values that are legitimately in the repo as documentation or fixtures.
 *
 * ⚠️ An allowlist, deliberately. Today's lesson, twice over: a denylist fails
 * open on anything nobody anticipated. Adding to this list should be a
 * conscious act visible in review.
 */
const ALLOWED = new Set([
  '192.168.1.20', '192.168.1.21', '192.168.1.5', '192.168.1.10', '192.168.1.100',
  '10.0.0.5', '127.0.0.1', '0.0.0.0', '192.168.1.42',
  '172.17.0.1', '172.18.0.1', '10.9.9.9', // docker/virtual, used in tests
]);

/** Files whose added lines are not worth scanning. */
const SKIP_FILE = /(^|\/)(package-lock\.json|.*\.example\.(yaml|yml|env)|\.env\.example|scripts\/scan-secrets\.mjs)$/;

const RULES = [
  {
    id: 'rtsp-credentials',
    re: /rtsp:\/\/[A-Za-z0-9_.-]+:[^@\s'"`]+@/g,
    // ${VAR} and obvious placeholders are configuration, not credentials.
    ok: (m) => /\$\{|<[a-z-]+>|user:pass|u:p@|USERNAME|PASSWORD/i.test(m),
    why: 'RTSP URL with inline credentials',
  },
  {
    id: 'homekit-pairing',
    re: /client_public=[0-9a-f]{16,}|device_private\s*:\s*\S+/gi,
    why: 'HomeKit pairing material — device_private exists nowhere else and is unrecoverable',
  },
  {
    id: 'mac-address',
    re: /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi,
    why: 'MAC address',
  },
  {
    id: 'long-hex-secret',
    re: /\b[0-9A-Fa-f]{16,}\b/g,
    // Digests and test fixtures are fine; a bare 16-64 hex run in prose is not.
    ok: (m, line) =>
      /sha256|sha512|integrity|digest|@sha|commit|revision|[0-9a-f]{64,}/i.test(line)
      || /^(?:0+|1+|a+|f+|deadbeef|AAAA1111BBBB2222|CCCC3333DDDD4444)$/i.test(m)
      // A git SHA pinned to a *_REF / *_SHA / *_COMMIT variable. Deliberately
      // narrow: EXACTLY 40 lowercase hex, and only on a line that assigns a ref.
      // Pin bumps recur, and if this fired every time, the habit would become
      // `leak-scan-ok` on every bump — which erodes the scanner far more than
      // this exemption does. A camera password (16 uppercase hex) still trips,
      // even on a *_REF line.
      || (/^[0-9a-f]{40}$/.test(m) && /\b[A-Z0-9_]*(_REF|_SHA|_COMMIT)\s*=/.test(line)),
    why: 'long hex value — camera RTSP passwords and session tokens look exactly like this',
  },
  {
    id: 'camera-id',
    re: /\b\d{9}-\d{4}\b/g,
    why: 'Alarm.com camera id (<unit>-<device>)',
  },
  {
    id: 'private-ip',
    re: /\b(?:192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/g,
    ok: (m) => ALLOWED.has(m),
    why: 'private LAN address',
  },
  {
    id: 'haiku',
    /**
     * 🔴 Anchored on the KEY, not the shape.
     *
     * The value is ~60 characters, ten words, letters only, ending in a period
     * — which is also a description of an ordinary English sentence. A
     * shape-based rule was written first and flagged **four passages of this
     * repo's own prose** on its first run against real history. A scanner that
     * fires on every paragraph gets switched off within a day, so a narrower
     * rule that survives protects more than a broad one that does not.
     *
     * ⚠️ The tradeoff is real and worth knowing: a bare Haiku value pasted
     * WITHOUT its key is not caught. Nothing distinguishes it from prose.
     */
    re: /\b(?:ADC_MOBILE_)?Haiku\s*[=:]\s*["']?[A-Za-z][A-Za-z ]{20,}/gi,
    why: 'Haiku device fingerprint (mobile API per-install secret)',
  },
];

function addedLines(argv) {
  if (argv.includes('--stdin')) {
    const text = readFileSync(0, 'utf-8');
    return parseDiff(text);
  }
  const i = argv.indexOf('--range');
  const args = i !== -1
    ? ['diff', '-U0', argv[i + 1], '--']
    : ['diff', '--cached', '-U0', '--'];
  return parseDiff(execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }));
}

function parseDiff(text) {
  const out = [];
  let file = '(unknown)';
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: line++, text: raw.slice(1) });
    }
  }
  return out;
}

const findings = [];
for (const { file, line, text } of addedLines(process.argv.slice(2))) {
  if (SKIP_FILE.test(file)) continue;
  if (/leak-scan-ok/.test(text)) continue;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const hit = m[0];
      if (rule.ok?.(hit, text)) continue;
      findings.push({ file, line, rule: rule.id, why: rule.why, hit });
    }
  }
}

if (findings.length === 0) {
  console.log('scan-secrets: clean');
  process.exit(0);
}

console.error(`\n🔴 scan-secrets: ${findings.length} finding(s) — COMMIT BLOCKED\n`);
for (const f of findings) {
  // ⚠️ Print the RULE and the location, never the full matched value — a
  // scanner that echoes what it found is itself a way to leak it, into terminal
  // scrollback and CI logs. Enough to locate, not enough to reuse.
  const preview = f.hit.length <= 8 ? f.hit : `${f.hit.slice(0, 4)}…${f.hit.slice(-2)} (${f.hit.length} chars)`;
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.rule} — ${f.why}`);
  console.error(`    matched: ${preview}\n`);
}
console.error('If a finding is a synthetic fixture, add `leak-scan-ok` in a comment on that line.');
console.error('If it is real, remove it — and remember it stays in history once committed.\n');
process.exit(1);
