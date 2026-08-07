import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig } from './config.js';

/**
 * Which cameras reach the WebRTC half, and — the part that broke production —
 * whether that half is started AT ALL.
 *
 * 🔴 `CameraManager.start()` throws on an empty list. That guard predates local
 * RTSP: when WebRTC was the only transport, "no cameras" could only mean a
 * misconfigured `config.yaml`. Once every camera can be served by a relay, an
 * empty list is a perfectly good deployment — and calling through anyway
 * crash-looped the bridge AFTER all three relays had come up healthy.
 *
 * ⚠️ `index.test.ts` mocks CameraManager with a `start` that resolves, so it
 * could not see this and stayed green throughout. The mock here THROWS on an
 * empty list exactly as the real one does; without that fidelity this file
 * would be theatre.
 */
const { cameraStart, relayCtor, exited, state } = vi.hoisted(() => ({
  cameraStart: vi.fn(),
  relayCtor: vi.fn(),
  exited: [] as number[],
  state: { config: null as unknown as AppConfig },
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => state.config),
  go2rtcRtspBaseUrl: vi.fn(() => 'rtsp://u:p@127.0.0.1:8554'),
}));

vi.mock('./utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  }),
  setLogLevel: vi.fn(),
}));

vi.mock('./go2rtc/go2rtc-api.js', () => ({
  Go2rtcApi: class {
    waitReady = vi.fn().mockResolvedValue(undefined);
    setMotion = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./auth/alarm-auth.js', () => ({ AlarmAuth: class { destroy = vi.fn(); } }));
vi.mock('./auth/token-manager.js', () => ({ TokenManager: class {} }));

vi.mock('./camera/camera-manager.js', () => ({
  CameraManager: class {
    // Faithful to src/camera/camera-manager.ts — this is the whole point.
    start = vi.fn(async (cameras: unknown[]) => {
      cameraStart(cameras);
      if (cameras.length === 0) throw new Error('No cameras configured.');
    });
    stop = vi.fn().mockResolvedValue(undefined);
    getStatus = vi.fn(() => ({}));
    getDiagnostics = vi.fn(() => ({}));
  },
}));

vi.mock('./events/alarm-event-listener.js', () => ({
  AlarmEventListener: class {
    on = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    circuitState = 'closed';
  },
}));

// Mocked so the branch logic is exercised without binding real sockets.
vi.mock('./rtsp/tunnel-relay.js', () => ({
  TunnelRelay: class {
    constructor(opts: unknown) { relayCtor(opts); }
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    getDiagnostics = vi.fn(() => ({ name: 'mock' }));
  },
}));

const local = (name: string, listenPort: number) => ({
  id: `1014-${listenPort}`, name, quality: 'hd' as const,
  localRtsp: { host: '10.0.0.1', port: 40001, path: '/s1', listenPort },
});
const webrtc = (name: string) => ({ id: `1014-${name}`, name, quality: 'hd' as const });

function makeConfig(cameras: unknown[]): AppConfig {
  return {
    alarm: { username: 'u', password: 'p' },
    cameras,
    go2rtc: { apiUrl: 'http://127.0.0.1:1984', rtspPort: 8554 },
    localRtsp: { bindAddress: '127.0.0.1' },
    logging: { level: 'info' },
  } as unknown as AppConfig;
}

async function runMain(): Promise<void> {
  vi.resetModules();
  await import('./index.js');
  await vi.advanceTimersByTimeAsync(0);
}

describe('camera transport selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cameraStart.mockClear();
    relayCtor.mockClear();
    exited.length = 0;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('does not start the WebRTC half when every camera is on a relay', async () => {
    state.config = makeConfig([local('front', 8561), local('kitchen', 8562), local('sunroom', 8563)]);

    await runMain();

    expect(relayCtor).toHaveBeenCalledTimes(3);
    expect(cameraStart).not.toHaveBeenCalled();
    // The regression: start([]) threw, main() caught it and exited 1, and
    // `restart: unless-stopped` did the rest.
    expect(exited).not.toContain(1);
  });

  it('starts the WebRTC half with only the non-relay cameras', async () => {
    state.config = makeConfig([local('front', 8561), webrtc('driveway')]);

    await runMain();

    expect(relayCtor).toHaveBeenCalledTimes(1);
    expect(cameraStart).toHaveBeenCalledTimes(1);
    const passed = cameraStart.mock.calls[0]![0] as Array<{ name: string }>;
    expect(passed.map((c) => c.name)).toEqual(['driveway']);
  });

  it('still fails loudly when NOTHING is configured', async () => {
    // No cameras and no relays is a real misconfiguration, and the original
    // error message is the useful one. Do not swallow it.
    state.config = makeConfig([]);

    await runMain();

    expect(cameraStart).toHaveBeenCalledWith([]);
    expect(exited).toContain(1);
  });
});
