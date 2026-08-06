import { describe, it, expect, afterEach } from 'vitest';
import { StatusServer } from './status-server.js';

const BASE = { bindAddress: '127.0.0.1', port: 0, username: 'u', password: 'p' };

describe('StatusServer construction', () => {
  it('refuses to start without credentials', () => {
    expect(
      () => new StatusServer({ ...BASE, password: '', getStatus: () => ({}) }),
    ).toThrow(/required/);
  });
});

describe('StatusServer requests', () => {
  let server: StatusServer | null = null;
  let port = 0;

  const startOn = async (getStatus: () => unknown) => {
    // Bind an ephemeral port, then read back what the OS assigned.
    const s = new StatusServer({ ...BASE, port: 0, getStatus });
    s.start();
    // @ts-expect-error reaching into the private handle for the assigned port
    await new Promise<void>((r) => s.server.once('listening', () => r()));
    // @ts-expect-error same
    port = s.server.address().port;
    server = s;
    return s;
  };

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('returns 401 without credentials', async () => {
    await startOn(() => ({ ok: true }));

    const res = await fetch(`http://127.0.0.1:${port}/`);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('returns 401 for wrong credentials', async () => {
    await startOn(() => ({ ok: true }));

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Basic ' + Buffer.from('u:wrong').toString('base64') },
    });

    expect(res.status).toBe(401);
  });

  it('serves the status payload when authenticated', async () => {
    await startOn(() => ({ running: true, cameras: [{ name: 'driveway' }] }));

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ running: true, cameras: [{ name: 'driveway' }] });
  });

  it('is read-only — rejects a POST even when authenticated', async () => {
    await startOn(() => ({ ok: true }));

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') },
    });

    expect(res.status).toBe(405);
  });
});

describe('StatusServer failure containment', () => {
  // A diagnostics endpoint must never be able to take down the bridge it
  // reports on. Binding an address the container does not own is the realistic
  // case: inside a bridge-network container the host's LAN address does not
  // exist, and an http.Server 'error' event with no listener THROWS.
  it('does not throw when the bind address is unavailable', async () => {
    const s = new StatusServer({
      bindAddress: '203.0.113.7', // TEST-NET-3, guaranteed not local
      port: 0,
      username: 'u',
      password: 'p',
      getStatus: () => ({}),
    });

    expect(() => s.start()).not.toThrow();
    // Give the async listen() error a tick to surface as an event.
    await new Promise((r) => setTimeout(r, 50));
    await s.stop();
  });

  it('accepts a wildcard bind, which is correct behind a compose port mapping', () => {
    expect(
      () =>
        new StatusServer({
          bindAddress: '0.0.0.0',
          port: 0,
          username: 'u',
          password: 'p',
          getStatus: () => ({}),
        }),
    ).not.toThrow();
  });
});
