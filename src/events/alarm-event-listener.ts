import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createChildLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';
import { CircuitBreaker, type CircuitState } from '../utils/circuit-breaker.js';
import type { AlarmAuth } from '../auth/alarm-auth.js';
import {
  EventType,
  type AlarmEvent,
  type AlarmEventListenerEvents,
} from './types.js';
import { parseBaseEvent, parseMotionEvent } from './parse-event.js';

const log = createChildLogger('alarm-events');

const WS_TOKEN_URL = 'https://www.alarm.com/web/api/websockets/token';
const TOKEN_REFRESH_MS = 240_000;

/**
 * `WebSocket.OPEN`. Written as a literal because the static is not guaranteed to
 * exist on every implementation the socket may be swapped for — comparing
 * against an `undefined` static silently reports every socket as disconnected.
 */
const WS_OPEN = 1;
const BACKOFF_STEPS_MS = [5_000, 10_000, 30_000, 60_000];
const EXPECTED_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1008]);
/**
 * Five consecutive failures is roughly 2.5 minutes of the backoff ladder above.
 * This is the loop that mattered: measured at ~60 failures/hour during the
 * 2026-08-03 outage, ten times the token poller's rate, because its ladder caps
 * at 60s and nothing ever stopped it.
 */
export const EVENT_FAILURE_THRESHOLD = 5;

interface WsTokenResponse {
  value: string;
  metaData: { endpoint: string };
}

/**
 * What the event listener can report about itself, for the status endpoint.
 *
 * 🔑 **`messagesReceived` is the field that matters**, and it exists because of
 * a real dead end: when HomeKit recording did not trigger, nothing could
 * distinguish "Alarm.com is sending no events at all" from "events arrive but
 * none are motion". Both look identical from outside — a connected socket and
 * silence — and answering it required `sudo docker-compose logs`, which is
 * exactly what this endpoint exists to avoid.
 *
 * ⚠️ `connected: true` is NOT evidence that events flow. The socket stayed up
 * and refreshed on schedule for 76 minutes while delivering nothing, because
 * Alarm.com emits motion only when a notification RULE is configured.
 */
export interface EventListenerDiagnostics {
  connected: boolean;
  circuit: CircuitState;
  /** Every message off the socket, including ones we do not act on. */
  messagesReceived: number;
  lastMessageAt: string | null;
  motionEvents: number;
  lastMotionAt: string | null;
  lastMotionCameraId: string | null;
  /** Parsed fine, but not a type this bridge handles. */
  unhandledEvents: number;
  connects: number;
  lastError?: string;
}

/**
 * Persistent WebSocket listener for Alarm.com device events.
 *
 * Emits typed events for motion, sensor changes, clip recordings, etc.
 * Automatically reconnects on disconnection.
 */
export class AlarmEventListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private running = false;
  private messagesReceived = 0;
  private motionEvents = 0;
  private unhandledEvents = 0;
  private connects = 0;
  private lastMessageAt: number | null = null;
  private lastMotionAt: number | null = null;
  private lastMotionCameraId: string | null = null;
  private lastError: string | undefined;
  private readonly breaker = new CircuitBreaker({
    label: 'events',
    failureThreshold: EVENT_FAILURE_THRESHOLD,
  });

  constructor(private readonly auth: AlarmAuth) {
    super();
  }

  /** Circuit state for this listener, for status reporting. */
  get circuitState(): CircuitState {
    return this.breaker.state;
  }

  /** Everything the status endpoint needs to answer "is motion working?". */
  getDiagnostics(): EventListenerDiagnostics {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      connected: this.ws !== null && this.ws.readyState === WS_OPEN,
      circuit: this.breaker.state,
      messagesReceived: this.messagesReceived,
      lastMessageAt: iso(this.lastMessageAt),
      motionEvents: this.motionEvents,
      lastMotionAt: iso(this.lastMotionAt),
      lastMotionCameraId: this.lastMotionCameraId,
      unhandledEvents: this.unhandledEvents,
      connects: this.connects,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    log.info('Stopped');
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async connect(): Promise<void> {
    this.clearTimers();

    if (!this.breaker.tryAttempt()) {
      log.debug('Reconnect suppressed — circuit open');
      // A denied attempt always leaves a positive remainder, but scheduling 0
      // here would recurse into connect() synchronously and blow the stack, so
      // do not let that invariant be the only thing standing between a future
      // refactor and a crash loop.
      this.scheduleReconnect(Math.max(1, this.breaker.retryAfterMs()));
      return;
    }

    // Whether this particular socket ever reached `open`. A socket that never
    // opened produced no usable result and is a circuit failure; one that
    // opened and later closed already recorded its success, and its close is
    // the start of a new attempt rather than the failure of this one.
    let opened = false;

    try {
      const tokenResponse = await retry(
        () => this.auth.get<WsTokenResponse>(WS_TOKEN_URL),
        { maxAttempts: 3, label: 'ws-token' },
      );

      const token = tokenResponse.value;
      const endpoint = tokenResponse.metaData?.endpoint;

      if (!token || !endpoint) {
        throw new Error('Invalid WebSocket token response');
      }

      const wsUrl = new URL(endpoint);
      if (wsUrl.protocol !== 'wss:') {
        throw new Error('Alarm.com event endpoint must use an encrypted WSS connection');
      }
      // Assign the raw query rather than using searchParams.set(). The token is
      // already a URL-encoded querystring (~600 chars of %XX escapes, & and =),
      // so encoding it a second time turns every % into %25 and Alarm.com
      // rejects the handshake with HTTP 401.
      wsUrl.search = `auth=${token}`;
      this.ws = new WebSocket(wsUrl.toString(), {
        handshakeTimeout: 30_000,
        maxPayload: 1024 * 1024,
      });

      this.ws.on('open', () => {
        log.info('WebSocket connected to %s', endpoint);
        opened = true;
        this.connects++;
        this.consecutiveFailures = 0;
        this.breaker.recordSuccess();
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          log.info('Proactive token refresh');
          this.closeAndReconnect();
        }, TOKEN_REFRESH_MS);
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        this.lastError = err.message;
        log.error('WebSocket error: %s', err.message);
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        log.warn('WebSocket closed: code=%d reason=%s', code, reason.toString());
        this.ws = null;
        this.clearTimers();

        if (!opened) {
          // Never opened — the handshake was rejected. This is the shape the
          // ~60/hour 401s took, and no exception was thrown for any of them.
          this.breaker.recordFailure(`closed before open (code ${code})`);
          this.scheduleReconnect(this.nextBackoffDelay());
          return;
        }

        if (EXPECTED_CLOSE_CODES.has(code)) {
          this.scheduleReconnect(0);
        } else {
          this.scheduleReconnect(this.nextBackoffDelay());
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to connect: %s', error.message);
      this.breaker.recordFailure(error.message);
      this.emit('error', error);
      this.scheduleReconnect(this.nextBackoffDelay());
    }
  }

  private closeAndReconnect(): void {
    if (!this.running) return;

    if (this.ws) {
      // Remove listeners before close to prevent the close handler from
      // firing and triggering a duplicate reconnect.
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.running) return;

    if (delayMs === 0) {
      log.info('Reconnecting immediately...');
      this.connect();
      return;
    }

    log.info('Reconnecting in %ds...', delayMs / 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private nextBackoffDelay(): number {
    // Once the circuit is open the fast ladder is abandoned for the breaker's
    // escalating cooldown; the ladder's own cap of 60s is what made this loop
    // the dominant source of failed calls during a sustained outage.
    if (this.breaker.state === 'open') return this.breaker.retryAfterMs();

    const delay = BACKOFF_STEPS_MS[Math.min(this.consecutiveFailures, BACKOFF_STEPS_MS.length - 1)];
    this.consecutiveFailures++;
    return delay;
  }

  private handleMessage(raw: string): void {
    this.messagesReceived++;
    this.lastMessageAt = Date.now();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn({ messageLength: raw.length }, 'Non-JSON event message');
      return;
    }

    const base = parseBaseEvent(msg);

    // Every event, before classification — so an event that ARRIVES but is
    // misclassified is distinguishable from no event at all. ⚠️ Field NAMES and
    // numeric types only: the payload carries account identifiers, and this
    // line would otherwise put them in the log.
    log.debug(
      {
        eventType: base.eventType,
        deviceType: base.deviceType,
        cameraId: base.cameraId,
        fields: Object.keys(msg).length,
      },
      'Event received',
    );
    this.emit('raw', base);

    switch (base.eventType) {
      case EventType.MOTION: {
        const motion = parseMotionEvent(base);
        this.motionEvents++;
        this.lastMotionAt = Date.now();
        this.lastMotionCameraId = motion.cameraId;
        log.info(
          { cameraId: motion.cameraId, rule: motion.ruleName },
          'Motion detected',
        );
        this.emit('motion', motion);
        break;
      }
      case EventType.MOTION_END:
        log.debug({ cameraId: base.cameraId }, 'Motion ended');
        this.emit('motionEnd', { ...base, eventType: EventType.MOTION_END });
        break;
      case EventType.VIDEO_CLIP:
        log.debug({ cameraId: base.cameraId }, 'Clip recorded');
        this.emit('clipRecorded', { ...base, eventType: EventType.VIDEO_CLIP });
        break;
      case EventType.SENSOR_CHANGE:
        log.debug({ cameraId: base.cameraId, value: base.eventValue }, 'Sensor change');
        this.emit('sensorChange', { ...base, eventType: EventType.SENSOR_CHANGE });
        break;
      default:
        this.unhandledEvents++;
        log.debug({ eventType: base.eventType, deviceId: base.deviceId }, 'Unhandled event type');
    }
  }
}

export declare interface AlarmEventListener {
  on<E extends keyof AlarmEventListenerEvents>(event: E, listener: AlarmEventListenerEvents[E]): this;
  emit<E extends keyof AlarmEventListenerEvents>(event: E, ...args: Parameters<AlarmEventListenerEvents[E]>): boolean;
}
