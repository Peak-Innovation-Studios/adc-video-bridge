# Make-before-break on token refresh

**Status:** Design approved 2026-08-04. Not implemented. Upstream issue
[Omar-L#25](https://github.com/Omar-L/adc-video-bridge/issues/25).

**Context:** measured 2026-08-03 (see `Journal.md`). At every 600s token refresh, RTP stops for
**~1.2s** and then resumes — consistently, every cycle. The RTSP publisher itself never drops:
`Starting ffmpeg` appears exactly once in 30 minutes, so the seamless-handoff design already works
at the *transport* layer. The gap is above it.

---

## The problem this design solves

`CameraStream.reconnect()` is break-before-make. It closes the old `RTCPeerConnection` **before**
building the new one:

```ts
if (this.pc) { await this.pc.close(); this.pc = null; }   // old dies here
this.pc = this.createPeerConnection(config);              // new starts here
```

`ffmpeg`, the UDP socket and `videoPort` all survive, so nothing restarts — ffmpeg simply receives
nothing for the ~1.2s it takes the replacement to negotiate. Invisible for live viewing. **Not
necessarily invisible to HKSV**, which cares about media continuity.

## What does *not* change

The data plane. Both sessions forward to the same `videoPort`; `ffmpeg`, `videoSocket` and the
allocated port are untouched. **The entire fix is which track is permitted to write to the socket.**
Everything difficult is in the control plane, where `this.pc` and `this.signaling` are single fields
reached into by ~6 methods.

## Architecture: extract `PeerSession`

New file `src/camera/peer-session.ts`. One `PeerSession` is one ADC session: its signaling client,
its `RTCPeerConnection`, its SDP/ICE handling, its track subscription, and its own `h264Fmtp`.

`CameraStream` keeps the data plane and the policy, and holds two of them:

```ts
private active: PeerSession | null = null;    // currently feeding ffmpeg
private pending: PeerSession | null = null;   // negotiating, not yet trusted
```

🔑 **A `PeerSession` does not know whether it is active.** It reports RTP with its own identity and
nothing more:

```ts
onRtp: (session: PeerSession, packet: Buffer) => void
```

All cutover policy therefore lives in exactly one place in `CameraStream`. This is deliberate: this
file has produced the same bug twice — *a reference held without asking which instance it points to*
(a placeholder track winning a one-shot guard; a dead process's `exit` callback clearing its
replacement). Overlapping sessions makes two live instances of everything legitimate, so the
"which instance am I?" question is answered structurally rather than by scattered guards.

Rejected alternative: adding `pendingPc`/`pendingSignaling` beside the existing fields with
`if (pc !== this.activePc) return` guards in each handler. Smaller diff, but it multiplies exactly
the check that has already been got wrong twice here.

Also rejected: pre-warming signaling without overlapping media. The cold-start breakdown bounds the
payoff — signaling 0.26s, SDP offer 0.51s, **connected 1.51s, first packet 1.52s**. Pre-warming
reclaims ~0.5s of ~1.5s; the rest is ICE/DTLS/first-packet, which inherently needs the new
`RTCPeerConnection` live. It cannot eliminate the gap, only shrink it by ~60%.

## Cutover

1. `reconnect(config)` builds a `pending` session and negotiates it. `active` keeps forwarding
   throughout.
2. **RTP from `pending` is dropped until cutover.** Two SSRCs interleaved on one UDP port would
   corrupt what ffmpeg is parsing mid-stream.
3. **Trigger: the first RTP packet on `pending`'s video track** — not `connectionState === connected`,
   which proves a transport rather than media.
4. Cutover: `active = pending; pending = null`, then close the old session. The switch is synchronous
   inside the RTP callback, so there is no interleaving window.

An SSRC/sequence discontinuity at the switch is acceptable: it already happens on every reconnect
today, and ffmpeg demonstrably tolerates it (`Starting ffmpeg` once per 30 minutes).

**Overlap budget: 10s.** Against a 1.5s observed cold start, a 10s dial-in retry delay, and a 600s
refresh cycle.

## Failure is free, not a fallback to the old gap

If `pending` is rejected, errors, or delivers no RTP within the budget:

- **`active` still streaming → discard `pending` and keep streaming.** The old token has no
  server-enforced session timeout (see `README.md`), so the next 600s refresh simply tries again.
  Cost: no gap, no ffmpeg restart, nothing user-visible.
- **`active` has died during the overlap → fall back to today's break-before-make.** Only used when
  there is nothing left to protect.

🔴 **`reconnect()` must not throw when it successfully keeps the old session.** Today a throw sends
`CameraManager` into a full restart, and since 2026-08-04 it also records a circuit-breaker failure.
A failed *overlap* on a healthy stream must do neither — otherwise repeated harmless overlap failures
would open the circuit on a working camera. `reconnect()` throws only when it ends with no live
session.

### When `reconnect()` resolves

**It resolves when the outcome is decided, not when `pending` finishes negotiating.** Today it
returns after `connectSignaling()` and media starts later in the handlers; that is fine when there is
only one session, but here `CameraManager` calls `breaker.recordSuccess()` on return, so resolving
early would record success for an overlap that has not happened yet and make the three outcomes
indistinguishable. The three resolutions are: cutover completed; `pending` discarded and `active`
retained; break-before-make fallback completed. Only "no live session remains" rejects.

The 10s budget is a timer that must be cleared on cutover and on discard, and by `stop()` — the file
already carries timer-ownership scars, so it gets the same treatment as the rest.

If `reconnect()` is called while a `pending` already exists, the previous `pending` is discarded and
closed first. `CameraManager`'s `activeStarts` guard makes this unlikely, but the class should not
depend on a caller's bookkeeping to avoid leaking a session.

## The feasibility unknown, and how production answers it

Nothing in the code establishes whether Alarm.com or the camera permits **two concurrent sessions for
one camera**. It cannot be tested until the camera's WiFi is fixed (baton item 1).

This design does not depend on the answer: rejection is just another `pending` failure, and the
fallback above makes it free. But the rejection must be **logged distinctly** — a `START_SESSION`
refusal or immediate signaling close on `pending`, while `active` is healthy, is the signature of
"ADC allows only one session per camera", and production logs then answer the question we cannot test
today. If that turns out to be the answer, the honest outcome is to revert to break-before-make and
close `#25` as won't-fix, keeping the `PeerSession` extraction if it has earned its keep.

## Session-scoped `h264Fmtp`

`handleSdpOffer()` currently writes `this.h264Fmtp` from the incoming offer. During an overlap that
is the *pending* offer being written while `active` is still streaming — shared mutable state across
two sessions, the same stale-reference shape as the two historical bugs. Harmless today because
ffmpeg's SDP is written once at spawn and never re-read, but it moves onto `PeerSession` so it cannot
become a real bug later.

## Testing

`src/camera/camera-stream.test.ts` already mocks the pieces. Add:

1. **Happy path** — overlap succeeds; RTP flows continuously across the switch; the old session is
   closed *after* cutover; ffmpeg is never restarted.
2. **Corruption guard** — RTP arriving on `pending` before cutover is **not** forwarded.
3. **Timeout** — `pending` delivers nothing within the budget; old session retained; no gap, no
   ffmpeg restart, and `reconnect()` does **not** throw.
4. **Rejection** — signaling refuses `pending`; same outcome as (3), plus the distinct log.
5. **Old dies mid-overlap** — falls back to break-before-make and completes.
6. **No breaker failure** — a failed overlap on a healthy stream records no circuit-breaker failure
   in `CameraManager`.

## Upstream portability

`camera-stream.ts` is where `Omar-L#23` and `#24` live, both still unmerged. This change is portable
but will conflict with them; send it only after those merge, and verify against **upstream's**
lockfile per the rule in the baton — including the broader form of that rule: any fixture exercising
code this fork's hardening made more tolerant will pass here and fail there.

## Open questions

- None blocking. The concurrency unknown is handled by design rather than resolved.
