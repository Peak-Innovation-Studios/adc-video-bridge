import { loadConfig, go2rtcRtspBaseUrl } from './config.js';
import { createChildLogger, setLogLevel } from './utils/logger.js';
import { AlarmAuth } from './auth/alarm-auth.js';
import { TokenManager } from './auth/token-manager.js';
import { CameraManager } from './camera/camera-manager.js';
import { Go2rtcApi } from './go2rtc/go2rtc-api.js';
import { StatusServer } from './status/status-server.js';
import { AlarmEventListener } from './events/alarm-event-listener.js';

const log = createChildLogger('main');

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

  // Optional read-only status endpoint. Absent config = no listener.
  let statusServer: StatusServer | null = null;
  if (config.status) {
    statusServer = new StatusServer({
      bindAddress: config.status.bindAddress,
      port: config.status.port,
      username: config.status.username ?? '',
      password: config.status.password ?? '',
      getStatus: () => cameraManager.getDiagnostics(),
    });
    statusServer.start();
  }

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
    await cameraManager.stop();
    auth.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start event listener and streaming
  await eventListener.start();
  await cameraManager.start(config.cameras);

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
