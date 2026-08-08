import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import type { MergeResult } from './config-writer.js';

/**
 * Apply a merge from `config-writer.ts` to a real file.
 *
 * 🔑 **Separated from the CLI so it can be tested.** `discover-local-cli.ts`
 * calls `main()` at module load, so anything living there is unreachable from a
 * test — and this is the half that touches `config/go2rtc.yaml`, where
 * `device_private` and `pairings` exist nowhere else. The pure merge decision
 * lives in `config-writer.ts`; this only carries out its verdict.
 *
 * 🔴 All three target files carry credentials, so anything written is forced to
 * 0600 — including the backup, which would otherwise inherit the umask and
 * leave a world-readable copy of the camera passwords next to the original.
 */

export const SECRET_MODE = 0o600;

export interface ApplyOutcome {
  /** False only when the merge refused; the file is then untouched. */
  written: boolean;
  refused?: string;
  /** Path of the backup taken, when an existing file was rewritten. */
  backup?: string;
  added: string[];
  skipped: string[];
}

export function applyMerge(
  path: string,
  merge: (text: string) => MergeResult,
  stamp: string,
  log: (line: string) => void = () => {},
  label = path,
): ApplyOutcome {
  const existed = existsSync(path);
  const result = merge(existed ? readFileSync(path, 'utf-8') : '');

  if (result.refused) {
    log(`  ⚠️  ${label} — NOT written: ${result.refused}`);
    return { written: false, refused: result.refused, added: [], skipped: result.skipped };
  }

  if (!result.changed) {
    const why = result.skipped.length > 0 ? ` (already has ${result.skipped.join(', ')})` : '';
    log(`  ✓  ${label} — already up to date${why}`);
    return { written: true, added: [], skipped: result.skipped };
  }

  // ⚠️ Back up BEFORE writing, not after — a crash between the two would
  // otherwise leave the original gone and no copy of it.
  let backup: string | undefined;
  if (existed) {
    backup = `${path}.bak-${stamp}`;
    copyFileSync(path, backup);
    chmodSync(backup, SECRET_MODE);
  }

  writeFileSync(path, result.text, { mode: SECRET_MODE });
  // `mode` on writeFileSync applies only when the file is CREATED, so an
  // existing file keeps whatever mode it had. chmod unconditionally.
  chmodSync(path, SECRET_MODE);

  const skipped = result.skipped.length > 0 ? `; left alone: ${result.skipped.join(', ')}` : '';
  log(`  ✓  ${label} — added ${result.added.join(', ')}${skipped}`);
  return { written: true, ...(backup ? { backup } : {}), added: result.added, skipped: result.skipped };
}
