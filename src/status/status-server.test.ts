import { describe, it, expect, afterEach } from 'vitest';
import { StatusServer } from './status-server.js';

const BASE = { bindAddress: '127.0.0.1', port: 0, username: 'u', password: 'p' };

describe('StatusServer construction', () => {
  // Under host networking there is no compose ports: mapping left to confine
  // this, so a wildcard bind is a real exposure, not a preference.
  it.each(['0.0.0.0', '::', ''])('refuses to bind the wildcard %s', (bindAddress) => {
    expect(
      () => new StatusServer({ ...BASE, bindAddress, getStatus: () => ({}) }),
    ).toThrow(/never a wildcard/);
  });

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
