import { loadConfig, go2rtcRtspBaseUrl } from './config.js';
import { createChildLogger, setLogLevel } from './utils/logger.js';
import { AlarmAuth } from './auth/alarm-auth.js';
import { TokenManager } from './auth/token-manager.js';
import { CameraManager } from './camera/camera-manager.js';
import { Go2rtcApi } from './go2rtc/go2rtc-api.js';
import { StatusServer } from './status/status-server.js';
import { AlarmEventListener } from './events/alarm-event-listener.js';
import { TunnelRelay } from './rtsp/tunnel-relay.js';
import type { AppConfig } from './config.js';

const log = createChildLogger('main');

/**
 * One relay per camera carrying a `localRtsp` block.
 *
 * 🔴 Never throws, and never returns a half-started set. A relay that cannot
 * bind must not take down the bridge — the WebRTC cameras, the motion fan-out
 * and the status endpoint are all still useful without it, and `restart:
 * unless-stopped` would otherwise turn one bad port into a crash loop. This is
 * the same rule `startStatusServer` follows, for the same reason.
 */
export async function startTunnelRelays(config: AppConfig): Promise<TunnelRelay[]> {
  const bindAddress = config.localRtsp?.bindAddress ?? '0.0.0.0';
  const maxConnections = config.localRtsp?.maxConnections;
  const started: TunnelRelay[] = [];

  for (const camera of config.cameras) {
    if (!camera.localRtsp) continue;
    const relay = new TunnelRelay({
      name: camera.name,
      host: camera.localRtsp.host,
      port: camera.localRtsp.port,
      path: camera.localRtsp.path ?? '/s1',
      bindAddress,
      listenPort: camera.localRtsp.listenPort,
      ...(maxConnections !== undefined ? { maxConnections } : {}),
    });
    try {
      await relay.start();
      started.push(relay);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ camera: camera.name }, 'Local RTSP relay not started: %s', msg);
    }
  }

  return started;
}

/**
 * Start the optional status endpoint, or return null.
 *
 * 🔴 Never throws. A diagnostics endpoint must not be able to take down the
 * bridge it reports on — and the constructor is synchronous, so guarding only
 * `listen()` was not enough. Production crash-looped on exactly this: a bad
 * `status.bindAddress` threw from the constructor, `main()` treated it as
 * fatal, and `restart: unless-stopped` did the rest.
 */
export function startStatusServer(
  status: { bindAddress: string; port: number; username?: string; password?: string },
  getStatus: () => unknown,
): StatusServer | null {
  try {
    const server = new StatusServer({
      bindAddress: status.bindAddress,
      port: status.port,
      username: status.username ?? '',
      password: status.password ?? '',
      getStatus,
    });
    server.start();
    return server;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Status endpoint not started, continuing without it: %s', msg);
    return null;
  }
}

async function main(): Promise<void> {
  log.info('adc-video-bridge starting');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.fatal('Config error: %s', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  setLogLevel(config.logging.level);

  log.info({ cameraCount: config.cameras.length }, 'Config loaded');

  // Wait for go2rtc
  const go2rtc = new Go2rtcApi(
    config.go2rtc.apiUrl,
    config.go2rtc.apiUsername && config.go2rtc.apiPassword
      ? { username: config.go2rtc.apiUsername, password: config.go2rtc.apiPassword }
      : undefined,
  );
  try {
    await go2rtc.waitReady();
  } catch {
    log.warn('go2rtc not available — streams will fail until go2rtc starts');
  }

  // Initialize auth
  const auth = new AlarmAuth(
    config.alarm.username,
    config.alarm.password,
    config.alarm.mfaToken,
  );

  // Initialize token manager and camera manager
  const tokenManager = new TokenManager(auth);
  const rtspBaseUrl = go2rtcRtspBaseUrl(config);
  const cameraManager = new CameraManager(tokenManager, rtspBaseUrl);

  // Initialize WebSocket event listener
  const eventListener = new AlarmEventListener(auth);
  eventListener.on('error', (err) => {
    log.warn('Event listener error: %s', err.message);
  });

  // Motion fan-out. Two independent sinks: the Homebridge webhook, and
  // go2rtc's native HomeKit motion sensor. During the cutover both accessories
  // exist, so both want telling; afterwards Homebridge's simply goes away.
  const hksvMotion = config.go2rtc.homekitMotion === true;
  if (config.homebridge?.motionUrl || hksvMotion) {
    const motionUrl = config.homebridge?.motionUrl;
    const motionTimeoutMs = config.homebridge?.motionTimeoutMs ?? 60_000;
    const cameraIdToHbName = new Map(
      config.cameras.map((c) => [c.id, c.homebridgeName ?? c.name]),
    );
    // go2rtc keys its HomeKit server by STREAM name, which is `name` — not
    // `homebridgeName`, which exists only to label the Homebridge accessory.
    const hbNameToStream = new Map(
      config.cameras.map((c) => [c.homebridgeName ?? c.name, c.name]),
    );
    const motionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const motionActive = new Set<string>();

    if (motionUrl) log.info({ motionUrl }, 'Homebridge motion webhooks enabled');
    if (hksvMotion) log.info('go2rtc HomeKit (HKSV) motion enabled');

    const sendHksvMotion = async (hbName: string, detected: boolean) => {
      const stream = hbNameToStream.get(hbName);
      if (!stream) return;
      try {
        await go2rtc.setMotion(stream, detected);
        log.info({ camera: stream, detected }, 'go2rtc HomeKit motion updated');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ camera: stream, detected }, 'go2rtc HomeKit motion failed: %s', msg);
      }
    };

    const sendMotionToggle = async (hbName: string) => {
      if (!motionUrl) return;
      const url = `${motionUrl}/motion?${encodeURIComponent(hbName)}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        log.info({ camera: hbName, status: res.status }, 'Motion webhook sent');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ camera: hbName }, 'Motion webhook failed: %s', msg);
      }
    };

    eventListener.on('motion', (event) => {
      const hbName = cameraIdToHbName.get(event.cameraId);
      if (!hbName) return;

      // Clear existing reset timer
      const existing = motionTimers.get(hbName);
      if (existing) clearTimeout(existing);

      // Trigger motion on (only if not already active)
      if (!motionActive.has(hbName)) {
        motionActive.add(hbName);
        sendMotionToggle(hbName);
        if (hksvMotion) sendHksvMotion(hbName, true);
      }

      // Schedule reset after timeout
      motionTimers.set(
        hbName,
        setTimeout(() => {
          motionTimers.delete(hbName);
          motionActive.delete(hbName);
          sendMotionToggle(hbName);
          if (hksvMotion) sendHksvMotion(hbName, false);
        }, motionTimeoutMs),
      );
    });
  }

  // Cameras reached over their own local RTSP. Started BEFORE the WebRTC half
  // so go2rtc can pull as soon as it has a source to pull from.
  const relays = await startTunnelRelays(config);
  if (relays.length > 0) {
    log.info({ count: relays.length }, 'Local RTSP relays running (no ffmpeg in the media path)');
  }

  // 🔑 A camera served by a relay is NOT started on the WebRTC path. Both
  // publish into the same go2rtc stream name, so running both would put two
  // producers on one stream — which does not error, it just interleaves.
  const webrtcCameras = config.cameras.filter((c) => !c.localRtsp);
  if (webrtcCameras.length !== config.cameras.length) {
    log.info(
      { local: config.cameras.length - webrtcCameras.length, webrtc: webrtcCameras.length },
      'Camera transports selected',
    );
  }

  // Optional read-only status endpoint. Absent config = no listener.
  const statusServer = config.status
    ? startStatusServer(config.status, () => ({
        ...cameraManager.getDiagnostics(),
        ...(relays.length > 0 ? { relays: relays.map((r) => r.getDiagnostics()) } : {}),
      }))
    : null;

  // Graceful shutdown
  let shutdownStarted = false;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log.info({ signal }, 'Shutting down...');
    if (statusTimer) clearInterval(statusTimer);
    eventListener.stop();
    if (statusServer) await statusServer.stop();
    await Promise.all(relays.map((r) => r.stop()));
    await cameraManager.stop();
    auth.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start event listener and streaming
  await eventListener.start();
  await cameraManager.start(webrtcCameras);

  // Periodic status logging
  statusTimer = setInterval(() => {
    const streams = cameraManager.getStatus();
    // The event circuit is only worth a field when it is open; a healthy one
    // would be noise on every line.
    if (eventListener.circuitState === 'open') {
      log.info({ streams, eventCircuit: 'open' }, 'Stream status');
    } else {
      log.info({ streams }, 'Stream status');
    }
  }, 60_000);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  log.fatal('Fatal error: %s', message);
  process.exit(1);
});
