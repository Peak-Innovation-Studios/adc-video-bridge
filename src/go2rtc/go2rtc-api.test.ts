import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { Go2rtcApi } from './go2rtc-api.js';

describe('Go2rtcApi', () => {
  let api: Go2rtcApi;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    api = new Go2rtcApi('http://localhost:1984');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('isHealthy', () => {
    it('returns true when API responds with 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      expect(await api.isHealthy()).toBe(true);
    });

    it('returns false when API responds with 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      expect(await api.isHealthy()).toBe(false);
    });

    it('returns false when network error occurs', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await api.isHealthy()).toBe(false);
    });
  });

  describe('getStreams', () => {
    it('returns parsed JSON on success', async () => {
      const streams = { driveway: {} };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(streams),
      });
      expect(await api.getStreams()).toEqual(streams);
    });

    it('throws on non-OK response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      await expect(api.getStreams()).rejects.toThrow();
    });

    it('throws on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(api.getStreams()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('waitReady', () => {
    it('resolves immediately when already healthy', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      await expect(api.waitReady()).resolves.toBeUndefined();
    });

    it('resolves when becomes healthy during polling', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: callCount >= 3 });
      });

      const promise = api.waitReady(10_000);
      await vi.advanceTimersByTimeAsync(1000); // poll 2
      await vi.advanceTimersByTimeAsync(1000); // poll 3 (healthy)
      await expect(promise).resolves.toBeUndefined();
    });

    it('throws when timeout is reached', async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

      const promise = api.waitReady(3000);
      // Attach a no-op rejection handler immediately to prevent unhandled rejection
      promise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).rejects.toThrow();
    });
  });

  describe('authentication', () => {
    it('sends HTTP Basic credentials when configured', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      globalThis.fetch = fetchMock;

      const authedApi = new Go2rtcApi('http://192.168.7.42:1984', { username: 'u', password: 'p' });
      await authedApi.getStreams();

      const init = fetchMock.mock.calls[0][1];
      expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    });

    it('sends no Authorization header when no credentials are configured', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      globalThis.fetch = fetchMock;

      await api.getStreams();

      const init = fetchMock.mock.calls[0][1];
      expect(init.headers?.Authorization).toBeUndefined();
    });

    it('sends the same credentials on isHealthy', async () => {
      // isHealthy is the request waitReady() makes at startup, before any
      // stream exists. With `local_auth: true` in config/go2rtc.yaml every
      // request authenticates, so an unauthenticated probe here would 401 and
      // the bridge would never get past waitReady().
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      globalThis.fetch = fetchMock;

      const authedApi = new Go2rtcApi('http://192.168.7.42:1984', { username: 'u', password: 'p' });
      expect(await authedApi.isHealthy()).toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://192.168.7.42:1984/api/streams');
      expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    });

    it('sends credentials on every waitReady poll, not just the first', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: callCount >= 3 });
      });
      globalThis.fetch = fetchMock;

      const authedApi = new Go2rtcApi('http://192.168.7.42:1984', { username: 'u', password: 'p' });
      const promise = authedApi.waitReady(10_000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toBeUndefined();

      const expected = `Basic ${Buffer.from('u:p').toString('base64')}`;
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init.headers.Authorization).toBe(expected);
      }
    });

    it('encodes a password containing a colon without truncating it', async () => {
      // HTTP Basic splits on the FIRST colon, so a colon in the password is
      // safe; one in the username would not be. Pin the encoding so a future
      // refactor cannot silently mangle a generated password.
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      globalThis.fetch = fetchMock;

      const authedApi = new Go2rtcApi('http://192.168.7.42:1984', {
        username: 'adcbridge',
        password: 'a:b/c@d',
      });
      await authedApi.getStreams();

      const init = fetchMock.mock.calls[0][1];
      const decoded = Buffer.from(
        init.headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString();
      expect(decoded).toBe('adcbridge:a:b/c@d');
    });
  });
});

describe('Go2rtcApi.setMotion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // go2rtc's contract is NOT a toggle: POST sets motion on, DELETE sets it off.
  it('POSTs to turn motion on, with the stream in the id query parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const api = new Go2rtcApi('http://192.168.7.42:1984', { username: 'u', password: 'p' });
    await api.setMotion('front', true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://192.168.7.42:1984/api/homekit/motion?id=front');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('DELETEs to turn motion off', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const api = new Go2rtcApi('http://192.168.7.42:1984', { username: 'u', password: 'p' });
    await api.setMotion('front', false);

    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('percent-encodes the stream name so it cannot break the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const api = new Go2rtcApi('http://192.168.7.42:1984');
    await api.setMotion('front door&x=1', true);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://192.168.7.42:1984/api/homekit/motion?id=front%20door%26x%3D1',
    );
  });

  it('throws on a non-ok response so the caller can log and continue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const api = new Go2rtcApi('http://192.168.7.42:1984');
    await expect(api.setMotion('front', true)).rejects.toThrow(/404/);
  });
});
