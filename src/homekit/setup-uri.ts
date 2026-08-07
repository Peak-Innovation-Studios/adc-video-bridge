import { createHash } from 'node:crypto';

/**
 * HomeKit setup payloads, derived exactly as go2rtc derives them.
 *
 * 🔑 **A QR containing only the PIN digits is not a setup payload.** The Home
 * app's scanner looks for an `X-HM://` URI, which packs the accessory CATEGORY,
 * feature flags, setup code and setup ID into one string. Scan a bare number
 * and Home has no idea what kind of accessory it is, so the camera pairing flow
 * never starts. That is the whole reason this file exists.
 *
 * ⚠️ Everything here must stay bit-identical to `pkg/hap/setup/setup.go` and
 * `pkg/hksv/helpers.go` in the pinned go2rtc we build. Nothing is configurable
 * on the go2rtc side: `setup_id` is not a config key at all, and `category_id`
 * defaults to camera. Derive, never transcribe.
 */

/** Accessory Category Identifier, advertised in the mDNS TXT record as `ci`. */
export const CATEGORY = {
  bridge: 2,
  camera: 17,
  doorbell: 18,
} as const;

export const CATEGORY_NAMES: Record<number, string> = {
  2: 'Bridge',
  17: 'IP Camera',
  18: 'Video Doorbell',
};

/** Setup payload feature flags. IP is the only one that applies here. */
export const FLAG_NFC = 1;
export const FLAG_IP = 2;
export const FLAG_BLE = 4;

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * go2rtc: `CalcSetupID(streamName)` = sha512 bytes 44 and 46, hex, uppercase.
 * 🔴 Derived from the STREAM NAME, never random. go2rtc publishes a hash of it
 * in the mDNS TXT record so Home can match a scanned QR to a discovered
 * accessory — an invented setup ID produces a QR that decodes fine and matches
 * nothing.
 */
export function calcSetupId(streamName: string): string {
  const digest = createHash('sha512').update(streamName).digest();
  return (
    digest[44]!.toString(16).padStart(2, '0') + digest[46]!.toString(16).padStart(2, '0')
  ).toUpperCase();
}

function formatBase36(value: bigint, width: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < width; i++) {
    out = BASE36[Number(v % 36n)] + out;
    v /= 36n;
  }
  return out;
}

/**
 * `payload = category<<31 | flags<<27 | setupCode`, base36 to 9 chars, then the
 * 4-character setup ID. Mirrors go2rtc's `GenerateSetupURI`.
 */
export function generateSetupUri(category: number, pin: string, setupId: string): string {
  const code = BigInt(pin.replaceAll('-', ''));
  const payload =
    ((BigInt(category) & 0xffn) << 31n) | ((BigInt(FLAG_IP) & 0xfn) << 27n) | (code & 0x7ffffffn);
  return `X-HM://${formatBase36(payload, 9)}${setupId}`;
}

export interface DecodedSetupUri {
  category: number;
  categoryName: string;
  flags: number;
  supportsIp: boolean;
  /** Formatted `XXX-XX-XXX`, as the Home app displays it. */
  pin: string;
  setupId: string;
}

/** Inverse of `generateSetupUri`, for checking a QR someone else produced. */
export function decodeSetupUri(uri: string): DecodedSetupUri | { error: string } {
  const match = /^X-HM:\/\/([0-9A-Z]{9})([0-9A-Z]{4})$/.exec(uri.trim().toUpperCase());
  if (!match) return { error: 'not a valid X-HM:// setup URI' };

  let value = 0n;
  for (const ch of match[1]!) value = value * 36n + BigInt(BASE36.indexOf(ch));

  const category = Number((value >> 31n) & 0xffn);
  const flags = Number((value >> 27n) & 0xfn);
  const digits = String(value & 0x7ffffffn).padStart(8, '0');
  return {
    category,
    categoryName: CATEGORY_NAMES[category] ?? `unknown (${category})`,
    flags,
    supportsIp: (flags & FLAG_IP) !== 0,
    pin: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`,
    setupId: match[2]!,
  };
}

/** `11223344` → `112-23-344`, the form printed under the QR and typed by hand. */
export function formatPin(pin: string): string {
  const digits = pin.replaceAll('-', '');
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}
