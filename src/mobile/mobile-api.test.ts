import { describe, it, expect, vi } from 'vitest';
import {
  mobileLogin,
  parseLoginResponse,
  parseRtspEndpoint,
  MobileApiError,
} from './mobile-api.js';

/**
 * The fixture mirrors the SHAPE of a real `<lnr>` response — the API's own
 * abbreviated attribute names — with entirely synthetic values. Nothing here
 * came from a real account.
 */
const LOGIN_XML = `<lnr st="AAAA1111BBBB2222CCCC3333DDDD4444" lr="0" tfas="0" dcid="99999999" lid="12345678">
  <cli model="ADC-V723" cd="Front Door" did="2050" UnitId="10000001" srt="true" SupportsWebRTC="true"
       l="camuser" p="AAAA1111BBBB2222"
       lre="rtsp://camuser:AAAA1111BBBB2222@192.168.1.20:40001/s1"
       pre="rtsp://camuser:AAAA1111BBBB2222@203.0.113.10:40001/s1" />
  <cli model="ADC-V515" cd="Back Room" did="2048" UnitId="10000001" srt="true" SupportsWebRTC="false"
       l="camuser" p="CCCC3333DDDD4444"
       lre="rtsp://camuser:CCCC3333DDDD4444@192.168.1.21:40002/s1" />
</lnr>`;

describe('parseRtspEndpoint', () => {
  it('splits credentials, host, port and path', () => {
    expect(parseRtspEndpoint('rtsp://u:p@10.0.0.5:41000/s1')).toEqual({
      username: 'u', password: 'p', host: '10.0.0.5', port: 41000, path: '/s1',
    });
  });

  it('returns undefined for empty or unparseable values', () => {
    // Cameras with no local endpoint publish an empty attribute.
    expect(parseRtspEndpoint('')).toBeUndefined();
    expect(parseRtspEndpoint(undefined)).toBeUndefined();
    expect(parseRtspEndpoint('not a url')).toBeUndefined();
  });

  it('decodes XML entities in the URL', () => {
    expect(parseRtspEndpoint('rtsp://u:a&amp;b@10.0.0.5:41000/s1')?.password).toBe('a&b');
  });
});

describe('parseLoginResponse', () => {
  const result = parseLoginResponse(LOGIN_XML);

  it('extracts the session token and customer id', () => {
    expect(result.loginResult).toBe(0);
    expect(result.sessionToken).toBe('AAAA1111BBBB2222CCCC3333DDDD4444');
    expect(result.customerId).toBe('99999999');
    expect(result.twoFactorRequired).toBe(false);
  });

  /**
   * 🔑 `UnitId` + `did` reconstruct the id the WEB API uses, so a camera
   * discovered here can be matched to `config.yaml` without a second lookup.
   * Verified against a real account 2026-08-07.
   */
  it('builds the web API camera id from UnitId and did', () => {
    expect(result.cameras.map((c) => c.cameraId)).toEqual(['10000001-2050', '10000001-2048']);
  });

  it('extracts the local RTSP endpoint with its credentials', () => {
    expect(result.cameras[0]!.localRtsp).toEqual({
      username: 'camuser', password: 'AAAA1111BBBB2222',
      host: '192.168.1.20', port: 40001, path: '/s1',
    });
  });

  /** 🔴 The field that decides whether a camera can EVER use the WebRTC path. */
  it('reports SupportsWebRTC per camera', () => {
    expect(result.cameras[0]!.supportsWebRtc).toBe(true);
    expect(result.cameras[1]!.supportsWebRtc).toBe(false);
  });

  it('carries description and model through', () => {
    expect(result.cameras[1]).toMatchObject({ description: 'Back Room', model: 'ADC-V515' });
  });

  it('rejects a response that is not a login document', () => {
    expect(() => parseLoginResponse('<html>Sign in</html>')).toThrow(/not a <lnr>/);
  });

  /**
   * 🔑 "Not a login document" covers an EMPTY body, an HTML error page and an
   * unrecognised challenge shape — three different problems needing three
   * different fixes. Each blind retry costs a login attempt against an account
   * Alarm.com can lock, so the error has to say which one it got.
   */
  it('says what it actually received, not just that parsing failed', () => {
    expect(() => parseLoginResponse('')).toThrow(/EMPTY body/);
    expect(() => parseLoginResponse('<html>Access Denied</html>')).toThrow(/Access Denied/);
    expect(() => parseLoginResponse('<x/>', 'HTTP 200, 4 raw bytes')).toThrow(/HTTP 200, 4 raw bytes/);
  });

  it('flags two-factor when tfas is non-zero', () => {
    expect(parseLoginResponse(LOGIN_XML.replace('tfas="0"', 'tfas="1"')).twoFactorRequired).toBe(true);
  });
});

describe('mobileLogin', () => {
  const ok = (body: string) =>
    vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  /**
   * 🔴 The server sends `Content-Encoding: gzip` and fetch does NOT transparently
   * decode it here. Reading `res.text()` yields compressed bytes as mojibake,
   * which parses as "not a login document" — indistinguishable from a rejected
   * login. That cost a wrong diagnosis before it was spotted.
   */
  it('gunzips a gzipped response body', async () => {
    const { gzipSync } = await import('node:zlib');
    const gz = vi.fn(async () => new Response(gzipSync(Buffer.from(LOGIN_XML)), { status: 200 }));
    const r = await mobileLogin({
      username: 'a', password: 'b', deviceUid: 'c',
      fetchImpl: gz as unknown as typeof fetch,
    });
    expect(r.cameras).toHaveLength(2);
  });

  /**
   * 🔴 A REJECTED login still returns HTTP 200 with a well-formed <lnr>. Only
   * `lr` distinguishes them, so trusting the status code accepts a failure.
   */
  it('treats lr != 0 as a rejected sign-in despite HTTP 200', async () => {
    await expect(
      mobileLogin({
        username: 'a', password: 'b', deviceUid: 'c',
        fetchImpl: ok('<lnr st="" lr="1" tfas="0" dcid="0"></lnr>'),
      }),
    ).rejects.toThrow(/rejected the sign-in \(lr=1\)/);
  });

  it('sends the full field set the app sends, not a minimal one', async () => {
    // Measured: a minimal request returns a body that is not a login document
    // at all — the handler bails with no error to read.
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({
      username: 'a', password: 'b', deviceUid: 'c',
      fetchImpl: spy as unknown as typeof fetch,
    });
    const init = spy.mock.calls[0]![1] as RequestInit;
    const sent = new URLSearchParams(String(init.body));
    for (const k of ['MobileManufacturer', 'ApplicationBuildNumber', 'BuildString', 'GmtOffsetMinutes', 'IncludeDashboard']) {
      expect(sent.has(k), `missing ${k}`).toBe(true);
    }
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/CFNetwork/);
  });

  it('omits HashCode unless one is supplied', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({ username: 'a', password: 'b', deviceUid: 'c', fetchImpl: spy as unknown as typeof fetch });
    expect(new URLSearchParams(String((spy.mock.calls[0]![1] as RequestInit).body)).has('HashCode')).toBe(false);
  });

  /**
   * 🔴 `Haiku` is the field whose absence produced every empty-body response.
   * The app sends 24 body fields; this client sent 23. Verified field-by-field
   * against a HAR of the real app, 2026-08-08.
   */
  it('sends Haiku when supplied', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({
      username: 'a', password: 'b', deviceUid: 'c', haiku: 'ten words separated by spaces.',
      fetchImpl: spy as unknown as typeof fetch,
    });
    const sent = new URLSearchParams(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(sent.get('Haiku')).toBe('ten words separated by spaces.');
  });

  it('omits Haiku unless one is supplied — the library imposes no policy', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({ username: 'a', password: 'b', deviceUid: 'c', fetchImpl: spy as unknown as typeof fetch });
    expect(new URLSearchParams(String((spy.mock.calls[0]![1] as RequestInit).body)).has('Haiku')).toBe(false);
  });

  /**
   * The app's own request is the specification. This pins the whole set so a
   * later "tidy-up" cannot silently drop a field — absence is indistinguishable
   * from a rejected login, and each test of it costs a real login attempt.
   */
  it('sends all 24 fields the app sends when every captured value is supplied', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({
      username: 'a', password: 'b', deviceUid: 'c',
      twoFactorId: 'tf', hashCode: '1234567890', haiku: 'a b c.',
      fetchImpl: spy as unknown as typeof fetch,
    });
    const sent = new URLSearchParams(String((spy.mock.calls[0]![1] as RequestInit).body));
    const APP_FIELDS = [
      'MobileDeviceType', 'IncludeRealTimeUpdates', 'RememberMe', 'Action', 'Password',
      'GmtOffsetMinutes', 'HashCode', 'Username', 'Culture', 'IncludeDealerBranding',
      'IncludeDashboard', 'PerformPushDeviceTokenCheck', 'BuildString', 'TwoFactorId',
      'IncludePushSettings', 'DeviceFlavor', 'MobileManufacturer', 'MobileDeviceUid',
      'IncludeAlarmModeEventsFilter', 'MobileDeviceModel', 'Haiku', 'ApplicationBuildNumber',
      'MobileDeviceOsVersion', 'UseNewSessionManager',
    ];
    for (const k of APP_FIELDS) expect(sent.has(k), `missing ${k}`).toBe(true);
    expect([...sent.keys()].length).toBe(APP_FIELDS.length);
  });

  // Values verified against the app's capture, 2026-08-08 — these are not guesses.
  it('matches the app on every hardcoded constant', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({ username: 'a', password: 'b', deviceUid: 'c', fetchImpl: spy as unknown as typeof fetch });
    const sent = new URLSearchParams(String((spy.mock.calls[0]![1] as RequestInit).body));
    for (const [k, v] of Object.entries({
      MobileDeviceType: '1', IncludeRealTimeUpdates: 'true', RememberMe: 'True',
      Action: 'UberLoginNew', Culture: 'en-US', IncludeDealerBranding: 'true',
      IncludeDashboard: 'true', PerformPushDeviceTokenCheck: 'True', BuildString: '5.13.1',
      IncludePushSettings: 'true', DeviceFlavor: '1', MobileManufacturer: 'Apple',
      IncludeAlarmModeEventsFilter: 'true', MobileDeviceModel: 'iPhone',
      ApplicationBuildNumber: '2051', MobileDeviceOsVersion: '27.0', UseNewSessionManager: 'true',
    })) {
      expect(sent.get(k), `${k} differs from the app`).toBe(v);
    }
  });

  /**
   * 🔑 The API answers an incomplete request with silence, so the client must
   * translate it. A bare "not a login document" sent the last investigation
   * down a rate-limit path for nine attempts.
   */
  it('explains the zero-byte body instead of just reporting it', async () => {
    await expect(
      mobileLogin({ username: 'a', password: 'b', deviceUid: 'c', fetchImpl: ok('') }),
    ).rejects.toThrow(/Haiku|missing body field/i);
  });

  it('does not claim rate limiting for an empty body, and says not to permute', async () => {
    const err = await mobileLogin({
      username: 'a', password: 'b', deviceUid: 'c', fetchImpl: ok(''),
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/NOT rate limiting/i);
    expect(String(err)).toMatch(/do not retry by varying fields/i);
  });

  // Positive control: the diagnosis must NOT be bolted onto every parse failure,
  // only the zero-byte one. A non-empty non-<lnr> body is a different problem.
  it('does not attach the empty-body diagnosis to a non-empty bad body', async () => {
    const err = await mobileLogin({
      username: 'a', password: 'b', deviceUid: 'c', fetchImpl: ok('<html>error</html>'),
    }).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/Haiku/);
    expect(String(err)).toMatch(/not a <lnr> login document/);
  });

  it('posts UberLoginNew with the credentials form-encoded', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({
      username: 'a@b.c', password: 'secret', deviceUid: 'UID-1',
      fetchImpl: spy as unknown as typeof fetch,
    });

    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/MobileServlet/SubmitRequest.aspx');
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get('Action')).toBe('UberLoginNew');
    expect(sent.get('Username')).toBe('a@b.c');
    expect(sent.get('MobileDeviceUid')).toBe('UID-1');
  });

  it('omits TwoFactorId when none is supplied', async () => {
    const spy = vi.fn(async () => new Response(LOGIN_XML, { status: 200 }));
    await mobileLogin({
      username: 'a@b.c', password: 'p', deviceUid: 'UID-1',
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(new URLSearchParams(String((spy.mock.calls[0]![1] as RequestInit).body)).has('TwoFactorId')).toBe(false);
  });

  /**
   * 🔴 One request, ever. This is an authentication endpoint and Alarm.com bans
   * accounts that poll it — a retry loop here risks locking the user out.
   */
  it('makes exactly one request, even on failure', async () => {
    const spy = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      mobileLogin({ username: 'a', password: 'b', deviceUid: 'c', fetchImpl: spy as unknown as typeof fetch }),
    ).rejects.toThrow(MobileApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('explains what to do when the account wants two-factor', async () => {
    await expect(
      mobileLogin({
        username: 'a', password: 'b', deviceUid: 'c',
        fetchImpl: ok(LOGIN_XML.replace('tfas="0"', 'tfas="2"')),
      }),
    ).rejects.toThrow(/two-factor/);
  });

  it('fails clearly when the login returns no cameras', async () => {
    await expect(
      mobileLogin({
        username: 'a', password: 'b', deviceUid: 'c',
        fetchImpl: ok('<lnr st="x" dcid="1" tfas="0"></lnr>'),
      }),
    ).rejects.toThrow(/no cameras/);
  });

  it('surfaces a network failure as MobileApiError', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(
      mobileLogin({ username: 'a', password: 'b', deviceUid: 'c', fetchImpl: boom as unknown as typeof fetch }),
    ).rejects.toThrow(/unreachable/);
  });
});
