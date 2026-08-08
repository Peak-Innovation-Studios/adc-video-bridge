import { gunzipSync } from 'node:zlib';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('mobile-api');

/**
 * Client for Alarm.com's **mobile** API — the only surface that publishes
 * per-camera local RTSP endpoints and their credentials.
 *
 * 🔑 **This is what makes the project adoptable.** Without it, obtaining camera
 * credentials requires a TLS-intercepting proxy and a trusted CA certificate on
 * a phone. With it, a user types their normal Alarm.com username and password.
 *
 * ⚠️ It is a separate, undocumented, legacy RPC-over-HTTP surface — form POSTs
 * with an `Action` parameter returning XML. It is unrelated to the
 * `www.alarm.com/web/api/…` REST API the rest of this project uses, and
 * Alarm.com can change it without notice.
 *
 * 🔴 **NEVER retry a failed login automatically.** `README.md` documents
 * Alarm.com banning accounts that poll aggressively, and this is an
 * authentication endpoint. One attempt, then surface the error. Callers must
 * not wrap this in a retry loop or a circuit breaker that probes.
 */

const ENDPOINT = 'https://mobile.alarm.com/MobileServlet/SubmitRequest.aspx';
const TIMEOUT_MS = 20_000;

export interface MobileLoginOptions {
  username: string;
  /** The account password, in plaintext — the API takes it directly, unhashed. */
  password: string;
  /**
   * A stable per-installation UUID. Generate once and persist it: Alarm.com
   * ties trusted-device state to this value, so a fresh one on every call looks
   * like a new device each time and can re-trigger two-factor.
   */
  deviceUid: string;
  /**
   * Trusted-device token from a previous two-factor completion. Without it a
   * two-factor-protected account will not return devices.
   */
  twoFactorId?: string;
  /**
   * Observed in the app's login as `HashCode` — a stable 10-digit per-install
   * value. 🔑 **A captured one is reusable.** It looks like a Unix timestamp
   * because of its width, and it is NOT: measured 2026-08-08 against the
   * capture's own `startedDateTime`, it is off by ~1188 days, so nothing about
   * it goes stale. The client never invents one — it is per-install.
   */
  hashCode?: string;
  /**
   * 🔴 **`Haiku` — the field whose ABSENCE produced every empty-body response.**
   *
   * The app sends 24 body fields; this client sent 23, and `Haiku` was the one
   * missing. `docs/MOBILE_API.md` records that an incomplete field set makes
   * the handler bail with HTTP 200 and a zero-byte body — no code, no message —
   * which is exactly what was measured on 2026-08-07 (nine times) and again on
   * 2026-08-08 after a ~15-hour cold start. ⚠️ **That second measurement is why
   * this is not a rate limit:** a throttle does not survive 15 hours of silence.
   *
   * The name is literal. The value is ~60 characters, all letters, ten words
   * separated by spaces and terminated with a period — a human-readable device
   * fingerprint, and a per-install secret. Capture it from the app's login; the
   * client never invents one.
   */
  haiku?: string;
  /** Test seam. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface MobileCameraRtsp {
  host: string;
  port: number;
  path: string;
  username: string;
  password: string;
}

export interface MobileCamera {
  /** `${unitId}-${deviceId}` — the SAME id the web API uses. */
  cameraId: string;
  unitId: number;
  deviceId: number;
  description: string;
  model: string;
  supportsRtsp: boolean;
  /** 🔴 `false` on ADC-V515: those cameras can never be served over WebRTC. */
  supportsWebRtc: boolean;
  /** Absent when the camera publishes no local endpoint. */
  localRtsp?: MobileCameraRtsp;
}

export interface MobileLoginResult {
  /** `lr` — 0 is success. ⚠️ A REJECTED login still returns HTTP 200. */
  loginResult: number;
  /** Session token (`st`), for any follow-up call. Not needed to read cameras. */
  sessionToken: string;
  customerId: string;
  /** `tfas` non-zero: the account wants two-factor and no `twoFactorId` satisfied it. */
  twoFactorRequired: boolean;
  cameras: MobileCamera[];
}

export class MobileApiError extends Error {}

/**
 * Attribute extractor for one XML element.
 *
 * A dependency-free parser is deliberate: the payload is attribute-only
 * elements with quoted values and no nesting we care about, so a real XML
 * parser would be a production dependency earning nothing. ⚠️ It is NOT a
 * general XML parser — it assumes double-quoted attributes, which is what this
 * API emits.
 */
function attributes(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of fragment.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const decodeEntities = (v: string): string =>
  v
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");

/** `rtsp://user:pass@host:port/path` → parts, or undefined if unparseable/empty. */
export function parseRtspEndpoint(value: string | undefined): MobileCameraRtsp | undefined {
  if (!value) return undefined;
  const m = /^rtsps?:\/\/([^:@/]+):([^@]*)@([^:/]+):(\d+)(\/\S*)?$/.exec(decodeEntities(value));
  if (!m) return undefined;
  return {
    username: m[1]!,
    password: m[2]!,
    host: m[3]!,
    port: Number(m[4]),
    path: m[5] ?? '/s1',
  };
}

/**
 * Parse the `<lnr>` login response.
 *
 * Attribute names are the API's own abbreviations, which is why they are mapped
 * here once rather than spread through the codebase:
 * `st` session token · `dcid` customer id · `tfas` two-factor status ·
 * `cli` camera list item · `lre` local RTSP · `l`/`p` camera credentials ·
 * `did` device id · `cd` description · `srt` supports RTSP streaming.
 */
export function parseLoginResponse(xml: string, context = ''): MobileLoginResult {
  const root = /<lnr\b([^>]*)>/.exec(xml);
  if (!root) {
    // ⚠️ Say WHAT came back. "Not a login document" covers an empty body, an
    // HTML error page and an unrecognised challenge shape — three different
    // problems that need three different fixes, and each blind retry costs a
    // login attempt against an account Alarm.com can lock.
    const preview = xml.slice(0, 160).replace(/\s+/g, ' ').trim();
    const shape = xml.length === 0 ? 'EMPTY body' : `${xml.length} chars starting: ${preview}`;
    // 🔑 A zero-byte 200 has one known cause, so say it rather than making the
    // next person rediscover it across nine logins. It is NOT a rate limit —
    // the same response came back after a ~15-hour cold start on 2026-08-08.
    const diagnosis =
      xml.length === 0
        ? '\n\n🔑 A zero-byte HTTP 200 means the handler rejected the request SHAPE, not the ' +
          'credentials — it bails without a code or message. The known cause is a MISSING BODY ' +
          'FIELD: the app sends 24, and `Haiku` is the one most easily missed (set ' +
          'ADC_MOBILE_HAIKU). ⚠️ This is NOT rate limiting — the identical response came back ' +
          'after a 15-hour cold start. Do NOT retry by varying fields: nine such attempts ' +
          'produced one real datum and a lot of noise. Diff your request against a capture of ' +
          'the app instead — that costs no logins. See docs/MOBILE_API.md.'
        : '';
    throw new MobileApiError(
      `response is not a <lnr> login document — got ${shape}${context ? ` (${context})` : ''}${diagnosis}`,
    );
  }
  const lnr = attributes(root[1]!);

  const cameras: MobileCamera[] = [];
  for (const m of xml.matchAll(/<cli\b([^>]*?)\/?>/g)) {
    const a = attributes(m[1]!);
    const unitId = Number(a.UnitId ?? 0);
    const deviceId = Number(a.did ?? 0);
    if (!unitId || !deviceId) continue;

    const local = parseRtspEndpoint(a.lre);
    cameras.push({
      cameraId: `${unitId}-${deviceId}`,
      unitId,
      deviceId,
      description: decodeEntities(a.cd ?? ''),
      model: a.model ?? '',
      supportsRtsp: a.srt === 'true',
      supportsWebRtc: a.SupportsWebRTC === 'true',
      ...(local ? { localRtsp: local } : {}),
    });
  }

  // `lr` is the login RESULT code: 0 on success. A rejected login still returns
  // HTTP 200 with a well-formed <lnr>, so the status code proves nothing.
  const loginResult = Number(lnr.lr ?? '0');

  return {
    loginResult,
    sessionToken: lnr.st ?? '',
    customerId: lnr.dcid ?? '',
    twoFactorRequired: (lnr.tfas ?? '0') !== '0',
    cameras,
  };
}

/**
 * Log in and return the account's cameras with their local RTSP endpoints.
 *
 * 🔴 Makes exactly ONE request. Do not retry on failure — see the file header.
 */
export async function mobileLogin(options: MobileLoginOptions): Promise<MobileLoginResult> {
  const body = new URLSearchParams({
    Action: 'UberLoginNew',
    Username: options.username,
    Password: options.password,
    MobileDeviceUid: options.deviceUid,
    ...(options.twoFactorId ? { TwoFactorId: options.twoFactorId } : {}),
    // 🔴 Send the app's FULL field set — all 24. Measured 2026-08-07: a request
    // missing any of them returns HTTP 200 with a zero-byte body — no code, no
    // message, the handler simply bails. There is no way to tell WHICH field it
    // wanted, so send them all.
    // ⚠️ This list was verified field-by-field against a HAR of the real app on
    // 2026-08-08: every constant below matches the app's value exactly, and the
    // only discrepancy was `Haiku`, which was missing entirely. Do not "tidy"
    // an unused-looking field out of here — absence is indistinguishable from a
    // rejected login, and each test costs a login against a lockable account.
    UseNewSessionManager: 'true',
    RememberMe: 'True',
    DeviceFlavor: '1',
    MobileDeviceType: '1',
    Culture: 'en-US',
    MobileManufacturer: 'Apple',
    MobileDeviceModel: 'iPhone',
    MobileDeviceOsVersion: '27.0',
    ApplicationBuildNumber: '2051',
    BuildString: '5.13.1',
    GmtOffsetMinutes: String(-new Date().getTimezoneOffset()),
    IncludeRealTimeUpdates: 'true',
    IncludeDealerBranding: 'true',
    IncludeDashboard: 'true',
    IncludePushSettings: 'true',
    IncludeAlarmModeEventsFilter: 'true',
    PerformPushDeviceTokenCheck: 'True',
    ...(options.hashCode ? { HashCode: options.hashCode } : {}),
    ...(options.haiku ? { Haiku: options.haiku } : {}),
  });

  const doFetch = options.fetchImpl ?? fetch;
  // ⚠️ Log that a login is happening, never WHAT is being sent — this body
  // carries the account password in plaintext.
  log.info('Signing in to the Alarm.com mobile API');

  let res: Response;
  try {
    res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // The handler appears to gate on a plausible client. A default Node
        // user agent was among the conditions under which it returned nothing.
        'User-Agent': 'MoniAlarm/5.13.1 CFNetwork/3892.100.1 Darwin/27.0.0',
        Accept: '*/*',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MobileApiError(
      `mobile API unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) throw new MobileApiError(`mobile API returned HTTP ${res.status}`);

  // 🔴 The server returns `Content-Encoding: gzip` and fetch does NOT transparently
  // decode it here — `res.text()` yields compressed bytes as mojibake, which
  // parses as "not a login document" and looks exactly like a rejected login.
  // Measured 2026-08-07; cost a wrong diagnosis before it was spotted.
  const buffer = Buffer.from(await res.arrayBuffer());
  let xml: string;
  try {
    xml = gunzipSync(buffer).toString('utf-8');
  } catch {
    xml = buffer.toString('utf-8');
  }

  const result = parseLoginResponse(
    xml,
    `HTTP ${res.status}, content-encoding=${res.headers.get('content-encoding') ?? 'none'}, ` +
      `${buffer.length} raw bytes, twoFactorId=${options.twoFactorId ? 'sent' : 'omitted'}`,
  );

  if (result.loginResult !== 0) {
    throw new MobileApiError(
      `Alarm.com rejected the sign-in (lr=${result.loginResult}). Check the username and ` +
        'password, and note that a trusted-device token can be rotated by another sign-in — ' +
        'capture a fresh TwoFactorId if you have one.',
    );
  }

  if (result.twoFactorRequired) {
    throw new MobileApiError(
      'this account requires two-factor authentication. Complete it once in the Alarm.com app, ' +
        'capture the TwoFactorId it then sends, and pass it as twoFactorId.',
    );
  }
  if (result.cameras.length === 0) {
    throw new MobileApiError('signed in, but the response contained no cameras.');
  }

  log.info({ cameras: result.cameras.length }, 'Mobile API sign-in succeeded');
  return result;
}
