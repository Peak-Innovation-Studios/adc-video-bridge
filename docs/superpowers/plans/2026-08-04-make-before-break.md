# Make-Before-Break Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the measured ~1.2s media gap at every 600s token refresh by overlapping the old and new Alarm.com WebRTC sessions instead of closing the old one first.

**Architecture:** Extract the control plane of one ADC session into a `PeerSession` unit (signaling client + `RTCPeerConnection` + SDP/ICE + track subscription). `CameraStream` keeps the data plane (`ffmpeg`, UDP socket, `videoPort`) and holds two sessions — `active` and `pending`. A `PeerSession` never knows whether it is active; it reports RTP with its own identity and all cutover policy lives in one place.

**Tech Stack:** TypeScript (ESM, NodeNext), werift, vitest with fake timers, pino.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-make-before-break-design.md`. Read it first.
- Overlap budget: **10s**. Cutover trigger: **first RTP packet** on `pending`'s video track.
- RTP from `pending` is **never forwarded before cutover** — two SSRCs on one UDP port corrupts what ffmpeg is parsing.
- `ffmpeg`, `videoSocket` and `videoPort` are **never** torn down or reallocated by `reconnect()`.
- `reconnect()` throws **only** when no live session remains.
- Every task ends with `npm run build && npm test` clean before commit.
- No AI attribution in commit messages.

---

### Task 1: Extract `PeerSession` (behaviour-preserving)

**Files:**
- Create: `src/camera/peer-session.ts`
- Create: `src/camera/peer-session.test.ts`
- Modify: `src/camera/camera-stream.ts` (delegate to `PeerSession`; remove the moved methods)
- Modify: `src/camera/camera-stream.test.ts` (mock adjustments only — no assertion changes)

**Interfaces:**
- Consumes: `SignalingClient` from `../signaling/signaling-client.js`; `parseH264Fmtp` from `../utils/sdp.js`.
- Produces:
  ```ts
  export interface PeerSessionCallbacks {
    onRtp: (session: PeerSession, packet: Buffer) => void;
    /** Fired once, when this session's video track is subscribed — before any RTP. */
    onTrackReady?: (session: PeerSession) => void;
    onFailed?: (session: PeerSession) => void;
  }
  export class PeerSession {
    readonly id: number;
    readonly signaling: SignalingClient;
    h264Fmtp: string | null;
    constructor(cameraName: string, callbacks: PeerSessionCallbacks);
    connect(config: EndToEndWebrtcConfig): Promise<void>;  // resolves on SESSION_STARTED
    close(): Promise<void>;                                 // idempotent
  }
  ```

Move into `PeerSession`, unchanged in behaviour: `createPeerConnection`, `setupPeerConnection`, `connectSignaling`, `registerPostSessionHandlers`, `handleSdpOffer`, `handleRemoteIceCandidate`, and `h264Fmtp`. **Preserve all three track-discovery paths** (`onTrack`, `ontrack`, the `connectionStateChange` transceiver scan) and the `rtpSubscribed` one-shot guard — that guard is the fix from `Omar-L#23` and must keep letting the real track win over the placeholder.

`CameraStream` keeps `startFfmpeg`, `allocateUdpPort`, `buildFmtp`, `videoSocket`, `videoPort`, `ffmpeg`, `_state`. `startFfmpeg` takes the session so it reads that session's fmtp: `private startFfmpeg(session: PeerSession): void` using `this.buildFmtp(session.h264Fmtp)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/camera/peer-session.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EndToEndWebrtcConfig } from '../types.js';

vi.mock('werift', () => ({ RTCPeerConnection: vi.fn(), RTCRtpCodecParameters: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../signaling/signaling-client.js', () => ({
  SignalingClient: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn((event: string, handler: any) => { if (event === 'sessionStarted') setTimeout(handler, 0); }),
      removeAllListeners: vi.fn(), close: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      sendAnswer: vi.fn(), sendIceCandidate: vi.fn(),
    } as any;
  }),
}));

import { PeerSession } from './peer-session.js';

const makeConfig = (): EndToEndWebrtcConfig => ({
  signallingServerUrl: 'wss://example.com', signallingServerToken: 'token',
  cameraAuthToken: 'auth', supportsAudio: false, supportsFullDuplex: false, iceServers: [],
});

afterEach(() => vi.clearAllMocks());

describe('PeerSession', () => {
  it('gives every session a distinct id, so callbacks can identify their origin', () => {
    const a = new PeerSession('cam', { onRtp: vi.fn() });
    const b = new PeerSession('cam', { onRtp: vi.fn() });
    expect(a.id).not.toBe(b.id);
  });

  it('reports RTP tagged with its own identity', () => {
    const onRtp = vi.fn();
    const session = new PeerSession('cam', { onRtp });
    const pc: any = { close: vi.fn().mockResolvedValue(undefined) };
    const track = { kind: 'video', onReceiveRtp: { subscribe: vi.fn() } };

    (session as any).pc = pc;
    (session as any).subscribeToRtp(track, 'test');
    const emit = track.onReceiveRtp.subscribe.mock.calls[0][0];
    emit({ serialize: () => Buffer.from([1, 2, 3]) });

    expect(onRtp).toHaveBeenCalledWith(session, Buffer.from([1, 2, 3]));
  });

  it('subscribes only the first track offered, so a placeholder cannot win', () => {
    const onRtp = vi.fn();
    const session = new PeerSession('cam', { onRtp });
    const real = { kind: 'video', onReceiveRtp: { subscribe: vi.fn() } };
    const later = { kind: 'video', onReceiveRtp: { subscribe: vi.fn() } };

    (session as any).subscribeToRtp(real, 'onTrack');
    (session as any).subscribeToRtp(later, 'scan');

    expect(real.onReceiveRtp.subscribe).toHaveBeenCalledTimes(1);
    expect(later.onReceiveRtp.subscribe).not.toHaveBeenCalled();
  });

  it('resolves connect() on SESSION_STARTED', async () => {
    const session = new PeerSession('cam', { onRtp: vi.fn() });
    vi.spyOn(session as any, 'createPeerConnection').mockReturnValue({});
    vi.spyOn(session as any, 'setupPeerConnection').mockImplementation(() => {});
    await expect(session.connect(makeConfig())).resolves.toBeUndefined();
  });

  it('close() is idempotent', async () => {
    const session = new PeerSession('cam', { onRtp: vi.fn() });
    const close = vi.fn().mockResolvedValue(undefined);
    (session as any).pc = { close };
    await session.close();
    await session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/camera/peer-session.test.ts`
Expected: FAIL — `Cannot find module './peer-session.js'`

- [ ] **Step 3: Create `src/camera/peer-session.ts`**

Move the six methods listed above verbatim from `camera-stream.ts`, changing only:
- `this.pc!` → the session's own `this.pc`
- the RTP forward body becomes `this.callbacks.onRtp(this, rtp.serialize())` — **no socket, no port, no ffmpeg in this file**
- `this._state = 'streaming'` is removed (state belongs to `CameraStream`)
- `connectionStateChange` on `failed`/`disconnected` calls `this.callbacks.onFailed?.(this)` instead of setting state
- `close()` guards on a `closed` flag so it is idempotent, and does `signaling.removeAllListeners(); signaling.close();` then `await pc?.close().catch(() => {})`

- [ ] **Step 4: Delegate from `CameraStream`**

ffmpeg still starts when the **track is subscribed**, not on the first packet — starting it later would send UDP to a port nothing is bound to yet and lose the opening frames. `startFfmpeg` is already idempotent (`if (this.ffmpeg) return`), so a second session firing `onTrackReady` during a later overlap is harmless.

```ts
private readonly sessionCallbacks: PeerSessionCallbacks = {
  onRtp: (session, packet) => this.handleRtp(session, packet),
  onTrackReady: (session) => {
    this.startFfmpeg(session);
    if (!this.videoSocket) this.videoSocket = createSocket('udp4');
    if (session === this.active) this._state = 'streaming';
  },
  onFailed: (session) => this.handleSessionFailed(session),
};

private async tryConnect(config: EndToEndWebrtcConfig): Promise<void> {
  await this.stop();
  this._state = 'connecting';
  this.videoPort = await this.allocateUdpPort();
  log.info({ camera: this.cameraName, videoPort: this.videoPort }, 'Allocated RTP port');
  const session = new PeerSession(this.cameraName, this.sessionCallbacks);
  this.active = session;
  await session.connect(config);
}
```

`handleSessionFailed` is a one-line stub in this task (`if (session === this.active) this._state = 'error';`); Task 5 completes it. `stop()` closes `this.active`, nulls it, and keeps its existing ffmpeg/socket teardown unchanged.

- [ ] **Step 5: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS, 145 tests. This task changes no behaviour. If a `camera-stream.test.ts` **assertion** must change, stop — that means behaviour moved and the extraction was not clean. Only mock plumbing may change.

- [ ] **Step 6: Commit**

```bash
git add src/camera/peer-session.ts src/camera/peer-session.test.ts src/camera/camera-stream.ts src/camera/camera-stream.test.ts
git commit -m "Extract PeerSession from CameraStream

Behaviour-preserving. Separates one ADC session's control plane from the
data plane so CameraStream can later hold two of them."
```

---

### Task 2: Hold `active` + `pending` with an identity gate

**Files:**
- Modify: `src/camera/camera-stream.ts`
- Modify: `src/camera/camera-stream.test.ts`

**Interfaces:**
- Consumes: `PeerSession` from Task 1.
- Produces: `private active: PeerSession | null`, `private pending: PeerSession | null`, `private handleRtp(session: PeerSession, packet: Buffer): void`.

No overlap yet — `pending` is always `null`. This task installs the gate alone, so it can be reviewed on its own.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/camera/camera-stream.test.ts
describe('CameraStream RTP identity gate', () => {
  let stream: CameraStream;
  beforeEach(() => { stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554'); });
  afterEach(() => vi.clearAllMocks());

  it('forwards RTP from the active session', () => {
    const socket = { send: vi.fn(), close: vi.fn() };
    const active: any = { id: 1 };
    (stream as any).active = active;
    (stream as any).videoSocket = socket;
    (stream as any).videoPort = 12345;
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };

    (stream as any).handleRtp(active, Buffer.from([9]));

    expect(socket.send).toHaveBeenCalledWith(Buffer.from([9]), 12345, '127.0.0.1');
  });

  it('drops RTP from a session that is neither active nor pending', () => {
    const socket = { send: vi.fn(), close: vi.fn() };
    (stream as any).active = { id: 1 };
    (stream as any).videoSocket = socket;
    (stream as any).videoPort = 12345;
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };

    (stream as any).handleRtp({ id: 99 }, Buffer.from([9]));

    expect(socket.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/camera/camera-stream.test.ts -t "identity gate"`
Expected: FAIL — `handleRtp is not a function` or the stale packet is forwarded.

- [ ] **Step 3: Implement the gate**

```ts
private handleRtp(session: PeerSession, packet: Buffer): void {
  if (session !== this.active) return;   // stale or not-yet-cut-over
  if (!this.videoSocket || !this.videoPort) return;
  this.videoSocket.send(packet, this.videoPort, '127.0.0.1');
}
```

- [ ] **Step 4: Run tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/camera/camera-stream.ts src/camera/camera-stream.test.ts
git commit -m "Gate RTP forwarding on session identity

Only the active session may write to the UDP socket. Two sessions
forwarding at once would interleave SSRCs on one port and corrupt what
ffmpeg is parsing."
```

---

### Task 3: Overlap and cut over on first RTP

**Files:**
- Modify: `src/camera/camera-stream.ts` (`reconnect`, `handleRtp`, new `cutOver`)
- Modify: `src/camera/camera-stream.test.ts` — ⚠️ **two existing tests must be rewritten here**

**Interfaces:**
- Produces:
  ```ts
  type OverlapOutcome = 'cutover' | 'kept' | 'fallback';
  private pending: PeerSession | null;
  private overlapTimer: ReturnType<typeof setTimeout> | null;   // armed in Task 4
  private overlapSettle: ((outcome: OverlapOutcome) => void) | null;
  private cutOver(session: PeerSession): void;
  private settleOverlap(outcome: OverlapOutcome): void;
  private clearOverlapTimer(): void;
  /** Build a PeerSession for `config` and await SESSION_STARTED. Rejects if ADC refuses. */
  private negotiatePending(config: EndToEndWebrtcConfig): Promise<void>;
  ```
  `settleOverlap` and `clearOverlapTimer` are introduced **here**, because `cutOver` calls them. Task 4 arms the timer; in this task `overlapTimer` stays `null` and `clearOverlapTimer` is a no-op guard.

⚠️ **These two existing tests encode break-before-make and will fail. Rewrite, do not delete:**
- `'closes old PC during reconnect'` → `'closes the old session only after cutover'`
- `'sets state to connecting during reconnect'` → `'keeps state streaming throughout the overlap'`. State staying `streaming` is correct now: media never stops, and `CameraManager` branches on `state === 'streaming'` to choose reconnect over restart.

- [ ] **Step 1: Write the failing tests**

```ts
describe('CameraStream make-before-break', () => {
  let stream: CameraStream;
  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { send: vi.fn(), close: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';
  });
  afterEach(() => vi.clearAllMocks());

  it('does not forward pending RTP before cutover', () => {
    const socket = (stream as any).videoSocket;
    const active: any = { id: 1 }; const pending: any = { id: 2 };
    (stream as any).active = active; (stream as any).pending = pending;

    (stream as any).handleRtp(pending, Buffer.from([7]));

    // The cutover consumes this very packet, so exactly one send occurs and
    // the two sessions are never both forwarding.
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect((stream as any).active).toBe(pending);
  });

  it('closes the old session only after cutover, never before', async () => {
    const oldClose = vi.fn().mockResolvedValue(undefined);
    const active: any = { id: 1, close: oldClose };
    const pending: any = { id: 2, close: vi.fn() };
    (stream as any).active = active; (stream as any).pending = pending;

    expect(oldClose).not.toHaveBeenCalled();
    (stream as any).cutOver(pending);
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();
    // The whole point: the RTSP publisher is never disturbed.
    expect((stream as any).ffmpeg.kill).not.toHaveBeenCalled();
    expect((stream as any).videoSocket.close).not.toHaveBeenCalled();
  });

  it('keeps state streaming throughout the overlap', async () => {
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = active;
    vi.spyOn(stream as any, 'negotiatePending').mockImplementation(async () => {
      expect(stream.state).toBe('streaming');   // never 'connecting'
    });
    await stream.reconnect(makeConfig()).catch(() => {});
    expect(stream.state).toBe('streaming');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/camera/camera-stream.test.ts -t "make-before-break"`
Expected: FAIL — `cutOver is not a function`

- [ ] **Step 3: Implement cutover and the overlap scaffolding**

```ts
private settleOverlap(outcome: OverlapOutcome): void {
  const settle = this.overlapSettle;
  this.overlapSettle = null;
  settle?.(outcome);
}

private clearOverlapTimer(): void {
  if (this.overlapTimer) { clearTimeout(this.overlapTimer); this.overlapTimer = null; }
}

private async negotiatePending(config: EndToEndWebrtcConfig): Promise<void> {
  const session = new PeerSession(this.cameraName, this.sessionCallbacks);
  this.pending = session;
  await session.connect(config);   // rejects if ADC refuses the second session
}
```

```ts
private handleRtp(session: PeerSession, packet: Buffer): void {
  // The first packet from pending is the proof that media flows on the new
  // session. Cut over here, then forward this same packet — nothing is lost.
  if (session === this.pending) this.cutOver(session);
  if (session !== this.active) return;
  if (!this.videoSocket || !this.videoPort) return;
  this.videoSocket.send(packet, this.videoPort, '127.0.0.1');
}

private cutOver(session: PeerSession): void {
  const previous = this.active;
  this.active = session;
  this.pending = null;
  this.clearOverlapTimer();
  this._state = 'streaming';
  log.info(
    { camera: this.cameraName, from: previous?.id, to: session.id },
    'Cut over to the new session without a media gap',
  );
  void previous?.close().catch(() => {});
  this.settleOverlap('cutover');
}
```

- [ ] **Step 4: Run tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/camera/camera-stream.ts src/camera/camera-stream.test.ts
git commit -m "Cut over to the new session on its first RTP packet

reconnect() now builds the replacement while the old session keeps
feeding ffmpeg. The first packet on the new track proves media flows and
triggers the switch; the old session is closed only afterwards."
```

---

### Task 4: Overlap budget, and keeping the old session when the new one fails

**Files:**
- Modify: `src/camera/camera-stream.ts`
- Modify: `src/camera/camera-stream.test.ts`

**Interfaces:**
- Consumes: `settleOverlap`, `clearOverlapTimer`, `negotiatePending`, `overlapSettle` from Task 3.
- Produces:
  ```ts
  export const OVERLAP_BUDGET_MS = 10_000;
  private discardPending(reason: string): Promise<void>;
  ```
  and `reconnect()` rewritten to arm the timer and await the outcome.

`reconnect()` resolves on **outcome**, not on negotiation — otherwise `CameraManager` records `breaker.recordSuccess()` for an overlap that has not happened.

- [ ] **Step 1: Write the failing test**

```ts
it('keeps the old session and does not throw when the new one never delivers', async () => {
  vi.useFakeTimers();
  const oldClose = vi.fn().mockResolvedValue(undefined);
  const active: any = { id: 1, close: oldClose };
  (stream as any).active = active;
  vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

  const promise = stream.reconnect(makeConfig());
  await vi.advanceTimersByTimeAsync(10_000);

  await expect(promise).resolves.toBeUndefined();   // must NOT throw
  expect((stream as any).active).toBe(active);      // old retained
  expect(oldClose).not.toHaveBeenCalled();
  expect((stream as any).pending).toBeNull();
  expect((stream as any).ffmpeg.kill).not.toHaveBeenCalled();
  expect(stream.state).toBe('streaming');
  vi.useRealTimers();
});

it('discards a previous pending rather than leaking it', async () => {
  const stale = { id: 5, close: vi.fn().mockResolvedValue(undefined) };
  (stream as any).active = { id: 1, close: vi.fn() };
  (stream as any).pending = stale;
  vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

  void stream.reconnect(makeConfig()).catch(() => {});
  await Promise.resolve();

  expect(stale.close).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/camera/camera-stream.test.ts -t "keeps the old session"`
Expected: FAIL — the promise rejects, or hangs past the budget.

- [ ] **Step 3: Implement the budget and the new `reconnect()`**

```ts
export const OVERLAP_BUDGET_MS = 10_000;

private async discardPending(reason: string): Promise<void> {
  const p = this.pending;
  this.pending = null;
  this.clearOverlapTimer();
  if (!p) return;
  log.warn({ camera: this.cameraName, session: p.id, reason }, 'Discarding pending session');
  await p.close().catch(() => {});
}

async reconnect(config: EndToEndWebrtcConfig): Promise<void> {
  if (this._state !== 'streaming') {
    throw new Error(`Cannot reconnect: expected 'streaming', got '${this._state}'`);
  }

  // Never depend on a caller's bookkeeping to avoid leaking a session.
  await this.discardPending('superseded by a newer reconnect');

  const outcome = new Promise<OverlapOutcome>((resolve) => {
    this.overlapSettle = resolve;
    this.overlapTimer = setTimeout(() => {
      void this.discardPending('no RTP within the overlap budget');
      this.settleOverlap('kept');
    }, OVERLAP_BUDGET_MS);
  });

  try {
    await this.negotiatePending(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await this.discardPending(msg);
    this.settleOverlap('kept');          // Task 5 adds the distinct log here
  }

  const result = await outcome;
  if (result === 'kept') {
    log.info({ camera: this.cameraName }, 'Overlap did not complete; keeping the current session');
    return;                               // healthy stream — must NOT throw
  }
}
```

`stop()` must also `clearOverlapTimer()`, close `pending`, and null both session fields.

- [ ] **Step 4: Run tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/camera/camera-stream.ts src/camera/camera-stream.test.ts
git commit -m "Bound the overlap and keep the old session when it fails

A failed overlap on a healthy stream costs nothing: the old token has no
server-enforced timeout, so the next refresh simply tries again.
reconnect() resolves on outcome rather than on negotiation, so a caller
cannot record success for an overlap that has not happened."
```

---

### Task 5: Rejection path and old-dies-mid-overlap fallback

**Files:**
- Modify: `src/camera/camera-stream.ts`
- Modify: `src/camera/camera-stream.test.ts`

**Interfaces:**
- Consumes: `discardPending`, `settleOverlap`, `OverlapOutcome` from Tasks 3–4.
- Produces:
  ```ts
  private activeDied: boolean;                              // set by handleSessionFailed
  private handleSessionFailed(session: PeerSession): void;   // completes Task 1's stub
  ```
  and the `'fallback'` branch of `reconnect()`'s outcome handling.

A `pending` rejected at `START_SESSION` while `active` is healthy is the signature of "ADC permits only one session per camera" — the question we cannot test until the camera's WiFi is fixed. It must be logged distinctly so production answers it.

- [ ] **Step 1: Write the failing test**

```ts
it('logs a rejected second session distinctly, and keeps streaming', async () => {
  const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
  (stream as any).active = active;
  vi.spyOn(stream as any, 'negotiatePending')
    .mockRejectedValue(new Error('SESSION_REJECTED'));

  await expect(stream.reconnect(makeConfig())).resolves.toBeUndefined();

  expect((stream as any).active).toBe(active);
  expect(stream.state).toBe('streaming');
});

it('falls back to break-before-make when the old session dies mid-overlap', async () => {
  const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
  (stream as any).active = active;
  const fallback = vi.spyOn(stream as any, 'tryConnect').mockResolvedValue(undefined);
  vi.spyOn(stream as any, 'negotiatePending').mockImplementation(async () => {
    (stream as any).handleSessionFailed(active);   // old dies during overlap
  });

  await stream.reconnect(makeConfig());

  expect(fallback).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/camera/camera-stream.test.ts -t "rejected second session"`
Expected: FAIL — `reconnect()` rejects instead of resolving.

- [ ] **Step 3: Implement**

```ts
private handleSessionFailed(session: PeerSession): void {
  if (session === this.pending) { void this.discardPending('peer connection failed'); return; }
  if (session !== this.active) return;
  this.activeDied = true;              // consulted when the overlap settles
  this._state = 'error';
}
```

On a rejected `pending`, log at `warn` with a stable marker so it is greppable:

```ts
log.warn(
  { camera: this.cameraName, reason: msg },
  'Second concurrent session refused by Alarm.com — keeping the current one. ' +
  'If this repeats every refresh, ADC permits only one session per camera and ' +
  'make-before-break is not achievable (see Omar-L#25).',
);
```

Then extend `reconnect()`'s outcome handling — this is the only path where it throws:

```ts
const result = await outcome;
if (result === 'kept' && !this.activeDied) {
  log.info({ camera: this.cameraName }, 'Overlap did not complete; keeping the current session');
  return;
}
// The old session died during the overlap, so there is nothing left to
// protect. Fall back to today's break-before-make and let it report.
this.activeDied = false;
log.warn({ camera: this.cameraName }, 'Active session died mid-overlap; falling back to a full reconnect');
await this.tryConnect(config);
```

- [ ] **Step 4: Run tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/camera/camera-stream.ts src/camera/camera-stream.test.ts
git commit -m "Handle a refused second session and a mid-overlap death

Break-before-make is used only when the old session has actually died,
i.e. when there is nothing left to protect. A refusal is logged with a
greppable marker so production tells us whether ADC allows two concurrent
sessions per camera."
```

---

### Task 6: Prove a failed overlap does not trip the circuit breaker

**Files:**
- Modify: `src/camera/camera-manager.test.ts`

`CameraManager.handleVideoToken` calls `breaker.recordSuccess()` when `reconnect()` resolves and `breaker.recordFailure()` when it throws. Tasks 4–5 make a failed overlap resolve, so this should already be correct — this task proves it and locks it down. **Expect no production code change.** If the test fails, the bug is in Task 4's resolution contract, not here.

- [ ] **Step 1: Write the test**

```ts
it('a failed overlap on a healthy stream is not a circuit-breaker failure', async () => {
  await startWithCamera();
  const stream = getStream();
  stream.state = 'streaming';
  // Overlap failed but the stream survived: reconnect() resolves.
  stream.reconnect.mockResolvedValue(undefined);

  for (let i = 0; i < 10; i++) {
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
  }

  expect(manager.getStatus()).toEqual({ driveway: 'streaming' });
  expect(stream.start).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/camera/camera-manager.test.ts -t "circuit-breaker failure"`
Expected: PASS with no production change.

- [ ] **Step 3: Full verification**

Run: `npm run build && npm test && npm run audit:prod`
Expected: build clean, all tests pass, audit passes with the documented GHSA-2p57-rm9w-gvfp exception.

- [ ] **Step 4: Commit**

```bash
git add src/camera/camera-manager.test.ts
git commit -m "Lock down that a failed overlap does not open the circuit

A harmless overlap failure on a working camera must not be recorded as a
breaker failure, or repeated ones would eventually pause a healthy stream."
```

---

## Verification

Live verification needs the camera's WiFi fixed (baton item 1) and a container rebuild. Once running, `Cut over to the new session without a media gap` should appear once per 600s, `Starting ffmpeg` should still appear only once per session, and the ~1.2s RTP silence at each refresh should be gone.

Do **not** send this upstream until `Omar-L#23` and `#24` merge — all three touch `camera-stream.ts`. Verify against upstream's lockfile per the baton, including the broadened form: any fixture exercising code this fork's hardening made more tolerant will pass here and fail there.
