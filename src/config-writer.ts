import { parseDocument, isMap, isSeq, type Document } from 'yaml';

/**
 * Merge generated configuration into the three files `discover:local` targets,
 * without destroying what is already there.
 *
 * 🔑 **Every function here is pure `string → string`.** No path, no `fs`. That
 * is deliberate and matches `verify-config.ts`: the risky logic is the merge,
 * and a merge that only takes text can be tested exhaustively without a
 * temporary directory or a real paired install to ruin.
 *
 * 🔴 **The rule that governs this whole file: REFUSE, never guess.** These
 * files hold state that exists nowhere else — HomeKit `pairings` and
 * `device_private` are generated once and cannot be recovered from a backup
 * that predates them. Anything ambiguous is reported and skipped, never
 * overwritten. A user who has to paste one block by hand has lost a minute; a
 * user whose pairings were clobbered has to re-pair every camera in the Home
 * app and loses their HKSV history.
 *
 * ⚠️ **`parseDocument` is used rather than `parse` because it round-trips.**
 * `parse` → mutate → `stringify` would silently strip every comment in the
 * user's file, which in `config/go2rtc.yaml` includes the `⚠️ contains camera
 * passwords` warning this project puts there on purpose.
 */

export interface MergeResult {
  /** File content to write. Equal to the input when `changed` is false. */
  text: string;
  /** Keys this merge added. */
  added: string[];
  /** Keys already present and therefore left exactly as they were. */
  skipped: string[];
  /**
   * Set when the file must not be written AT ALL, with the reason. When
   * present, `text` is the untouched input and callers must fall back to
   * printing the block for the user to merge by hand.
   */
  refused?: string;
  changed: boolean;
}

export interface StreamEntry {
  name: string;
  /** `rtsp://user:pass@${GO2RTC_BIND}:port/path` — carries camera credentials. */
  url: string;
}

export interface HomekitEntry {
  name: string;
  pin: string;
  displayName: string;
  motionThreshold: number;
}

/** First relay port. Shared so the two CLIs cannot drift apart. */
export const RELAY_PORT_BASE = 8561;

/**
 * Assign a `listenPort` to each camera, avoiding every port already in use.
 *
 * 🔴 **Replaces `RELAY_PORT_BASE + arrayIndex`, which collides.** `mergeConfigYaml`
 * skips a camera whose `id` is already present, so on a re-run an EXISTING
 * camera keeps its stored port while a NEW camera sitting at a lower index gets
 * handed the same number — two relays binding one port. It went unnoticed
 * because the first live run matched production exactly, but only because
 * Alarm.com happened to return the cameras in the order the config was written.
 * **That match validated the API parsing, not the port assignment.**
 *
 * 🔑 A camera already in the config keeps the port it already has. Renumbering a
 * working camera would silently break it: `config.yaml`, the `go2rtc.yaml`
 * stream URL and the published compose range all have to agree, and nothing
 * fails loudly when they stop — the stream simply reads offline.
 */
export function allocateListenPorts(
  existing: Array<{ id: string; listenPort: number }>,
  cameraIds: string[],
  base = RELAY_PORT_BASE,
): Map<string, number> {
  const stored = new Map(existing.map((e) => [e.id, e.listenPort]));
  // Every stored port is reserved, INCLUDING cameras not in this run — they are
  // still configured and still bind their port.
  const taken = new Set(existing.map((e) => e.listenPort));
  const out = new Map<string, number>();

  for (const id of cameraIds) {
    const reuse = stored.get(id);
    if (reuse !== undefined) {
      out.set(id, reuse);
      continue;
    }
    let port = base;
    while (taken.has(port)) port++;
    taken.add(port);
    out.set(id, port);
  }
  return out;
}

/**
 * The `ADC_BRIDGE_RTSP_PORTS` range that covers every allocated port.
 *
 * ⚠️ Must span the MIN and MAX actually in use, not `base + count`. With a gap
 * — a camera removed, or ports allocated across several runs — a count-derived
 * range leaves the highest port unpublished, and `.env.example` records what
 * that looks like: a stream go2rtc reports as offline, with no error logged
 * anywhere. Spare ports inside the range are harmless.
 */
export function portRangeCovering(ports: number[], base = RELAY_PORT_BASE): string {
  if (ports.length === 0) return `${base}-${base}`;
  return `${Math.min(...ports)}-${Math.max(...ports)}`;
}

export interface CameraEntry {
  id: string;
  name: string;
  quality: string;
  localRtsp: { host: string; port: number; listenPort: number; path?: string };
}

const unchanged = (text: string, refused?: string): MergeResult => ({
  text,
  added: [],
  skipped: [],
  ...(refused ? { refused } : {}),
  changed: false,
});

/**
 * Parse, refusing on any error.
 *
 * ⚠️ A YAML error here is NOT a reason to rewrite the file from scratch. The
 * user's file is the source of truth for everything we did not generate, so a
 * file we cannot parse is a file we must not touch.
 */
function load(text: string): { doc: Document } | { refused: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { refused: `it does not parse (${doc.errors[0]!.message.split('\n')[0]})` };
  }
  return { doc };
}

/**
 * 🔴 The single most important check in this file.
 *
 * A `pairings` list means Apple Home has completed a HomeKit pairing against
 * this accessory. The private half lives in `device_private` in this same file
 * and exists nowhere else. go2rtc also **writes this file itself** when
 * pairings change, so an automated write can race it and lose one.
 *
 * ⚠️ Do not soften this to "merge everything except the paired keys". The
 * failure it prevents is not a bad key, it is a file written at the wrong
 * moment — and that is a property of the FILE, not of the individual key.
 */
function findPairings(doc: Document): string[] {
  const homekit = doc.get('homekit');
  if (!isMap(homekit)) return [];
  const paired: string[] = [];
  for (const item of homekit.items) {
    const key = String(item.key);
    const block = item.value;
    if (!isMap(block)) continue;
    const pairings = block.get('pairings');
    if (isSeq(pairings) && pairings.items.length > 0) paired.push(key);
  }
  return paired;
}

/**
 * Merge `streams:` and `homekit:` into `config/go2rtc.yaml`.
 *
 * 🔴 Refuses outright if ANY accessory is already paired — see `findPairings`.
 * 🔑 Merges INTO the existing maps. Appending a second `streams:` block would
 * create a duplicate top-level key, which `verify-config.ts` documents as
 * silently discarding one block and disabling go2rtc's own config writes.
 */
export function mergeGo2rtcYaml(
  existing: string,
  streams: StreamEntry[],
  homekit: HomekitEntry[],
): MergeResult {
  const loaded = load(existing);
  if ('refused' in loaded) return unchanged(existing, loaded.refused);
  const { doc } = loaded;

  const paired = findPairings(doc);
  if (paired.length > 0) {
    return unchanged(
      existing,
      `it already has HomeKit pairings (${paired.join(', ')}). go2rtc writes this file itself and ` +
        'the private key exists nowhere else, so it is never written automatically once paired',
    );
  }

  const added: string[] = [];
  const skipped: string[] = [];

  const ensureMap = (key: string) => {
    let node = doc.get(key);
    if (node === undefined || node === null) {
      doc.set(key, doc.createNode({}));
      node = doc.get(key);
    }
    return isMap(node) ? node : undefined;
  };

  const streamMap = ensureMap('streams');
  if (!streamMap) return unchanged(existing, '`streams:` exists but is not a mapping');
  for (const s of streams) {
    if (streamMap.has(s.name)) skipped.push(`streams.${s.name}`);
    else {
      streamMap.set(s.name, s.url);
      added.push(`streams.${s.name}`);
    }
  }

  const homekitMap = ensureMap('homekit');
  if (!homekitMap) return unchanged(existing, '`homekit:` exists but is not a mapping');
  for (const h of homekit) {
    if (homekitMap.has(h.name)) skipped.push(`homekit.${h.name}`);
    else {
      homekitMap.set(
        h.name,
        doc.createNode({
          pin: h.pin,
          name: h.displayName,
          hksv: true,
          motion: 'detect',
          motion_threshold: h.motionThreshold,
        }),
      );
      added.push(`homekit.${h.name}`);
    }
  }

  if (added.length === 0) return { text: existing, added, skipped, changed: false };
  return { text: doc.toString(), added, skipped, changed: true };
}

/**
 * Merge cameras into `config/config.yaml`.
 *
 * 🔑 Identity is the Alarm.com camera `id`, not the list position or the name —
 * a user may well have renamed a camera, and re-adding it under a second entry
 * would start a second relay against the same device on a different port.
 */
export function mergeConfigYaml(existing: string, cameras: CameraEntry[]): MergeResult {
  const loaded = load(existing);
  if ('refused' in loaded) return unchanged(existing, loaded.refused);
  const { doc } = loaded;

  let list = doc.get('cameras');
  if (list === undefined || list === null) {
    doc.set('cameras', doc.createNode([]));
    list = doc.get('cameras');
  }
  if (!isSeq(list)) return unchanged(existing, '`cameras:` exists but is not a list');

  const present = new Set(
    list.items.map((item) => (isMap(item) ? String(item.get('id') ?? '') : '')).filter(Boolean),
  );

  const added: string[] = [];
  const skipped: string[] = [];
  for (const cam of cameras) {
    if (present.has(cam.id)) {
      skipped.push(cam.id);
      continue;
    }
    list.add(
      doc.createNode({
        id: cam.id,
        name: cam.name,
        quality: cam.quality,
        localRtsp: {
          host: cam.localRtsp.host,
          port: cam.localRtsp.port,
          listenPort: cam.localRtsp.listenPort,
          ...(cam.localRtsp.path && cam.localRtsp.path !== '/s1' ? { path: cam.localRtsp.path } : {}),
        },
      }),
    );
    added.push(cam.id);
  }

  if (added.length === 0) return { text: existing, added, skipped, changed: false };
  return { text: doc.toString(), added, skipped, changed: true };
}

/**
 * Set `KEY=value` in a `.env` file.
 *
 * ⚠️ Deliberately line-based rather than parsed: `.env` is not YAML, it is read
 * by both Compose and the shell, and a round-trip through any parser risks
 * changing quoting in ways those two disagree about.
 *
 * 🔑 An existing key with a DIFFERENT value is skipped, never rewritten. The
 * user may have chosen their port range on purpose, and silently moving it
 * would break the published container ports against a config that still names
 * the old ones.
 */
export function mergeEnv(
  existing: string,
  key: string,
  value: string,
  options: {
    /**
     * Quote both values in the conflict message. 🔴 **Defaults to false, and
     * that default is the point.** `.env` holds camera and go2rtc passwords, so
     * a conflict message that echoes values leaks a credential to stdout — and
     * to whatever captured it — every time it fires. Callers opt IN for values
     * that are genuinely useful to see, like a port range.
     */
    revealOnConflict?: boolean;
  } = {},
): MergeResult {
  const lines = existing.split('\n');
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));

  if (idx !== -1) {
    const current = lines[idx]!.slice(lines[idx]!.indexOf('=') + 1).trim();
    if (current === value) return { text: existing, added: [], skipped: [key], changed: false };
    return unchanged(
      existing,
      options.revealOnConflict
        ? `${key} is already set to "${current}", not "${value}" — set it by hand if the new value is right`
        : `${key} is already set to a different value — left alone. Edit .env by hand if it is wrong`,
    );
  }

  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  return {
    text: `${existing}${needsNewline ? '\n' : ''}${key}=${value}\n`,
    added: [key],
    skipped: [],
    changed: true,
  };
}
