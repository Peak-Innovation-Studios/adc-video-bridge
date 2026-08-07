import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const CAMERA_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAMERA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * The camera's own RTSP endpoint, tunnelled over HTTPS. Present = this camera
 * is served by the local relay and is NOT started on the WebRTC path, so the
 * two can never both publish into one go2rtc stream.
 *
 * 🔑 There are no credentials here on purpose. The relay is a byte relay; the
 * RTSP client (go2rtc) authenticates to the camera end to end through it, so
 * the camera's Digest credentials live in `config/go2rtc.yaml` — already a
 * mode-600 secret holding HomeKit private keys — and never in this file or in
 * the credential-holding bridge container.
 */
export interface LocalRtspConfig {
  /** Camera's LAN address, from the mobile API's `LocalRtspEndpoint`. */
  host: string;
  /** Per-camera tunnel port from the same endpoint. Not 554. */
  port: number;
  /** Defaults to `/s1`, which is what every camera seen so far serves. */
  path?: string;
  /** Port the relay listens on, and that go2rtc's stream source points at. */
  listenPort: number;
}

export interface CameraConfig {
  id: string;
  name: string;
  homebridgeName?: string;
  quality: 'hd' | 'sd';
  localRtsp?: LocalRtspConfig;
}

export interface HomebridgeConfig {
  motionUrl: string;
  motionTimeoutMs: number;
}

export interface AppConfig {
  alarm: {
    username: string;
    password: string;
    mfaToken?: string;
  };
  cameras: CameraConfig[];
  go2rtc: {
    apiUrl: string;
    rtspPort: number;
    apiUsername?: string;
    apiPassword?: string;
    rtspUsername?: string;
    rtspPassword?: string;
    /**
     * Drive go2rtc's native HomeKit motion sensor (`motion: api` in
     * go2rtc.yaml). Independent of `homebridge.motionUrl`: during the cutover
     * both accessories exist and both want telling.
     */
    homekitMotion?: boolean;
  };
  homebridge?: HomebridgeConfig;
  /**
   * Settings shared by every camera's local RTSP relay. Only consulted when at
   * least one camera has a `localRtsp` block.
   */
  localRtsp?: {
    /**
     * ⚠️ The address INSIDE the container, exactly like `status.bindAddress`.
     * The host's LAN address does not exist on the default bridge network, so
     * binding it there fails with EADDRNOTAVAIL. Confinement comes from
     * compose's `ports:` mapping, which binds the host side to
     * ADC_BRIDGE_BIND_ADDRESS.
     */
    bindAddress: string;
    maxConnections?: number;
  };
  /**
   * Optional read-only status endpoint. Absent = no listener at all, which is
   * the default and preserves the post-split property that the bridge listens
   * on nothing.
   */
  status?: {
    bindAddress: string;
    port: number;
    username?: string;
    password?: string;
  };
  logging: {
    level: string;
  };
}

const DEFAULT_CONFIG: Omit<AppConfig, 'alarm'> = {
  cameras: [],
  go2rtc: {
    // Explicit loopback, not `localhost`: `localhost` can resolve to `::1`,
    // which ffmpeg treats differently than the IPv4 loopback address.
    apiUrl: 'http://127.0.0.1:1984',
    rtspPort: 8554,
  },
  logging: {
    level: 'info',
  },
};

function readEnvironmentSecret(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;

  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) return undefined;

  try {
    const value = readFileSync(filePath, 'utf-8').trim();
    if (!value) throw new Error('file is empty');
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read ${name}_FILE: ${message}`);
  }
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

const RTSP_HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const RTSP_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]*$/;

function validatePort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return value;
}

function validateConfig(config: AppConfig): AppConfig {
  validatePort(config.go2rtc.rtspPort, 'go2rtc.rtspPort');

  config.go2rtc.apiUrl = validateHttpUrl(config.go2rtc.apiUrl, 'go2rtc.apiUrl');

  if (!LOG_LEVELS.has(config.logging.level)) {
    throw new Error(`logging.level must be one of: ${[...LOG_LEVELS].join(', ')}.`);
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  const listenPorts = new Set<number>();
  for (const camera of config.cameras) {
    if (!CAMERA_ID_PATTERN.test(camera.id)) {
      throw new Error(`Camera ID ${JSON.stringify(camera.id)} contains unsupported characters.`);
    }
    if (!CAMERA_NAME_PATTERN.test(camera.name)) {
      throw new Error(
        `Camera name ${JSON.stringify(camera.name)} must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or hyphens.`,
      );
    }
    if (camera.quality !== 'hd' && camera.quality !== 'sd') {
      throw new Error(`Camera ${camera.name} quality must be "hd" or "sd".`);
    }
    if (ids.has(camera.id)) throw new Error(`Duplicate camera ID: ${camera.id}.`);
    if (names.has(camera.name)) throw new Error(`Duplicate camera name: ${camera.name}.`);
    ids.add(camera.id);
    names.add(camera.name);

    if (camera.localRtsp) {
      const local = camera.localRtsp;
      const label = `Camera ${camera.name} localRtsp`;
      if (typeof local.host !== 'string' || !RTSP_HOST_PATTERN.test(local.host)) {
        throw new Error(
          `${label}.host must be a bare hostname or IP address — no scheme, port, path or credentials.`,
        );
      }
      validatePort(local.port, `${label}.port`);
      validatePort(local.listenPort, `${label}.listenPort`);
      if (local.path === undefined) {
        local.path = '/s1';
      } else if (typeof local.path !== 'string' || !RTSP_PATH_PATTERN.test(local.path)) {
        throw new Error(`${label}.path must start with "/" and contain no query string or spaces.`);
      }
      // Two relays on one port would bind-race at startup and then serve one
      // camera's video under both stream names, which looks like a wiring
      // mistake in HomeKit rather than a config error.
      if (listenPorts.has(local.listenPort)) {
        throw new Error(`Duplicate localRtsp.listenPort: ${local.listenPort}.`);
      }
      listenPorts.add(local.listenPort);
    }
  }

  if (listenPorts.size > 0 && config.status && listenPorts.has(config.status.port)) {
    throw new Error(
      `localRtsp.listenPort ${config.status.port} collides with status.port. ` +
        'The status endpoint would lose the race and the bridge would report nothing.',
    );
  }

  const maxConnections = config.localRtsp?.maxConnections;
  if (maxConnections !== undefined && (!Number.isInteger(maxConnections) || maxConnections < 1)) {
    throw new Error('localRtsp.maxConnections must be an integer of at least 1.');
  }

  if (config.homebridge) {
    config.homebridge.motionUrl = validateHttpUrl(
      config.homebridge.motionUrl,
      'homebridge.motionUrl',
    );
    if (!Number.isInteger(config.homebridge.motionTimeoutMs) || config.homebridge.motionTimeoutMs < 1_000) {
      throw new Error('homebridge.motionTimeoutMs must be an integer of at least 1000 milliseconds.');
    }
  }

  return config;
}

/**
 * Load config from YAML file, falling back to environment variables.
 * Config file is searched at: ./config/config.yaml, then ./config.yaml
 */
export function loadConfig(): AppConfig {
  const configPaths = [
    resolve(process.cwd(), 'config', 'config.yaml'),
    resolve(process.cwd(), 'config.yaml'),
  ];

  let fileConfig: Partial<AppConfig> = {};

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      // Docker creates a DIRECTORY at a single-file bind mount whose host file
      // is missing, and existsSync() is true for a directory — so without this
      // the failure surfaced as a bare EISDIR naming neither file nor cause.
      if (!statSync(configPath).isFile()) {
        throw new Error(
          `${configPath} is a directory, not a file. This usually means Docker created it ` +
            'for a bind mount whose host file does not exist — run ' +
            '"cp config/config.example.yaml config/config.yaml" and recreate the container.',
        );
      }
      const raw = readFileSync(configPath, 'utf-8');
      fileConfig = (parse(raw) as Partial<AppConfig>) ?? {};
      break;
    }
  }

  const alarm = {
    // Environment or Docker secret files take precedence so production
    // credentials never need to live in the mounted YAML configuration.
    username: readEnvironmentSecret('ADC_USERNAME') || fileConfig.alarm?.username || '',
    password: readEnvironmentSecret('ADC_PASSWORD') || fileConfig.alarm?.password || '',
    mfaToken:
      readEnvironmentSecret('ADC_MFA_TOKEN') || fileConfig.alarm?.mfaToken || undefined,
  };

  if (!alarm.username || !alarm.password) {
    throw new Error(
      'Alarm.com credentials required. Set in config.yaml or ADC_USERNAME/ADC_PASSWORD env vars.',
    );
  }

  return validateConfig({
    alarm,
    cameras: Array.isArray(fileConfig.cameras) ? fileConfig.cameras : DEFAULT_CONFIG.cameras,
    go2rtc: {
      ...DEFAULT_CONFIG.go2rtc,
      ...fileConfig.go2rtc,
      apiUsername: readEnvironmentSecret('GO2RTC_API_USERNAME') ?? fileConfig.go2rtc?.apiUsername,
      apiPassword: readEnvironmentSecret('GO2RTC_API_PASSWORD') ?? fileConfig.go2rtc?.apiPassword,
      rtspUsername: readEnvironmentSecret('GO2RTC_RTSP_USERNAME') ?? fileConfig.go2rtc?.rtspUsername,
      rtspPassword: readEnvironmentSecret('GO2RTC_RTSP_PASSWORD') ?? fileConfig.go2rtc?.rtspPassword,
    },
    status: fileConfig.status
      ? {
          bindAddress: fileConfig.status.bindAddress,
          port: fileConfig.status.port ?? 9090,
          username: readEnvironmentSecret('STATUS_USERNAME') ?? fileConfig.status.username,
          password: readEnvironmentSecret('STATUS_PASSWORD') ?? fileConfig.status.password,
        }
      : undefined,
    localRtsp: {
      // 0.0.0.0 for the same reason status.bindAddress is: this is the address
      // inside the container, and the host's LAN address does not exist there.
      bindAddress: fileConfig.localRtsp?.bindAddress ?? '0.0.0.0',
      ...(fileConfig.localRtsp?.maxConnections !== undefined
        ? { maxConnections: fileConfig.localRtsp.maxConnections }
        : {}),
    },
    homebridge: fileConfig.homebridge
      ? {
          motionUrl: fileConfig.homebridge.motionUrl,
          motionTimeoutMs: fileConfig.homebridge.motionTimeoutMs ?? 60_000,
        }
      : undefined,
    logging: { ...DEFAULT_CONFIG.logging, ...fileConfig.logging },
  });
}

/**
 * The RTSP base URL ffmpeg publishes to. Derived from `apiUrl` rather than
 * configured separately: both address the same go2rtc, and two keys could
 * drift apart silently after the container split.
 */
export function go2rtcRtspBaseUrl(config: AppConfig): string {
  const host = new URL(config.go2rtc.apiUrl).hostname;
  const { rtspUsername, rtspPassword } = config.go2rtc;
  // encodeURIComponent so a password containing / : @ cannot break the URL.
  const auth =
    rtspUsername && rtspPassword
      ? `${encodeURIComponent(rtspUsername)}:${encodeURIComponent(rtspPassword)}@`
      : '';
  return `rtsp://${auth}${host}:${config.go2rtc.rtspPort}`;
}
