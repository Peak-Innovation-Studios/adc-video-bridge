# Journal

Narrative history: **why** things are the way they are. Live state lives in
`docs/AGENT_HANDOFF.md` — if the two disagree, the baton wins.

Read the most recent entry; `grep` for older ones. When this file gets long, move older entries
to `docs/journal/` unedited and leave a pointer here — do **not** start a new log file.

---

## 2026-08-03 — A "no video" outage that was poor WiFi, plus measured performance findings

**Claude Code (Opus 5), taking over from Codex.**

### The outage, and why the obvious reading was wrong

Symptom: no video. `/api/frame.jpeg` returned HTTP 200 with **0 bytes in ~1 ms**, three times
running. That single observation eliminated the whole right-hand side of the architecture —
go2rtc answered instantly because the stream was *declared*, and returned nothing because no
producer existed. The fault was upstream of go2rtc, and everything downstream was merely idle.

Tracing up: the ADC video-source call returned HTTP 200 with `errorEnum: 0` — a **success** — but
`relationships.endToEndWebrtcConnectionInfo.data == null`, with `proxyWebrtcConnectionInfo`
offered instead. `token-manager.ts` matches only the end-to-end type, so `fetchVideoSource`
returned `null` and the pipeline never started: zero `Allocated RTP port`, zero `Starting ffmpeg`.

**The wrong conclusion, and how convincing it was.** This looked exactly like a vendor transport
migration. Supporting it: a real API field had gone `null`; a documented alternative transport had
appeared in its place; upstream `Omar-L#2` described precisely that split by camera model; and
Alarm.com's own docs corroborated the proxy timeout and audio limits we were observing. A Janus
proxy implementation was scoped and about to start.

**What broke the false trail:** David observed that Alarm.com's **phone app** streamed the camera
while their **website** timed out. Two first-party clients disagreeing is a fact about the network
path — it cannot be explained by any server-side, protocol, or entitlement theory. That reframed
everything, and the camera's WiFi signal turned out to be poor.

**Actual root cause: poor WiFi signal at the camera.** Per Alarm.com's
[knowledge base](https://answers.alarm.com/Customer/Website_and_App/Video/Live_Video/View_live_video),
a Proxy connection *"means that attempts to establish a Direct or Relayed connection have
failed"*, times out after 3 minutes, and carries no audio — which is why a demoted camera reports
`proxyStreamTimeoutTime: 180` and `supportsAudio: false`. Proxy is the **failure fallback**. A weak
link made Direct connections fail; Alarm.com demoted the camera; our bridge only speaks Direct.

**Resolution:** power-cycling the camera cleared the demotion.
`endToEndWebrtcConnectionInfo` returned with data (plus `webrtcStreamQualityMessage` entries,
which only appear on a healthy source), and video was verified end to end — 84–127 KB JPEGs with
three distinct md5s across 30 s, and a real `rtsp+tcp` publisher in go2rtc with bytes climbing.

**No code was changed.** The lesson is recorded as a diagnostic order in the baton: check
Alarm.com's own clients *first*, and treat a disagreement between them as a network-path signal.

### Measured performance findings

Two hypotheses were tested and **refuted**:

1. *"Homebridge is re-encoding."* It is not — `vcodec: "copy"`. No transcode, no wasted NAS CPU.
2. *"The 10-second ffmpeg `analyzeduration` delays startup."* It does not. `analyzeduration` is a
   ceiling, not a fixed wait. Cold start measured **1.52 s** from RTP port allocation to first RTP
   packet: signaling session 0.26 s, SDP offer 0.51 s, ffmpeg spawned 0.55 s, peer connection
   connected 1.51 s, first packet 1.52 s. There is nothing to reclaim here.

One finding that **was** real, and was not on the original list:

3. **A ~1.2 s media gap every 600 s.** At each token refresh the peer connection closes and RTP
   resumes ~1.2 s later — consistently, every cycle. The good news is that `Starting ffmpeg`
   appears exactly **once** in 30 minutes, so the seamless-handoff design works: ffmpeg and the UDP
   socket survive refreshes and the RTSP publisher never drops. But it is seamless at the
   *transport* layer only. `reconnect()` closes the old PeerConnection **before** building the new
   one — break-before-make — so ffmpeg receives nothing during the overlap. Invisible for live
   viewing; **not** necessarily invisible to HKSV, which cares about media continuity.
   Fix: make-before-break — establish the new connection, wait for RTP on it, then tear down the
   old one.

Untested and deliberately deferred: `-reorder_queue_size 0` disables RTP reordering, which is
right on a clean LAN and possibly wrong over a weak wireless link. Worth an A/B **after** the
signal problem is fixed, not before.

### Native HKSV via go2rtc — assessed, and declined for now

[go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is **still open** (not merged, not
draft, 8,399 additions across 35 files, last updated 2026-07-27), and go2rtc's latest release is
v1.9.14 from January. There is no release path; adopting it means self-building from an unmerged
branch.

Upstream `Omar-L#11` argues two benefits, and both fail **for this deployment**: the re-encoding it
eliminates is already not happening (`vcodec: "copy"`), and the Homebridge stack it removes is
staying regardless, because this Homebridge also hosts non-camera accessories. Meanwhile the cost
is concrete: the Dockerfile pins go2rtc **by digest**, and `SECURITY_AUDIT.md` names that as a
deliberate supply-chain control. Swapping in a self-built binary from an unmerged PR — running as a
HomeKit accessory holding pairing keys — trades that guarantee away.

HKSV already works through the current stack, so this is an optimization of a working path, not an
enabler. **Decision: track it; revisit after it merges and ships in an official release.**

### Deferred to a future session

The **ADC API circuit breaker** (upstream `Omar-L#9`) was scoped but deliberately not started.
Decisions already made, so the next session does not re-litigate them:

- **Scope: all three retry loops**, not just token calls. Measured during the outage: the event
  WebSocket produced ~60 failures/hour (backoff caps at 60 s) versus ~6/hour from the token poller
  (caps at 600 s). Guarding only `token-manager.ts`, as upstream proposes, would leave 60 of 66
  hourly failures untouched. Backoff bounds the *rate* between attempts; nothing bounds the
  *duration* of attempting, and a saturated ladder is still an infinite loop.
- **Open behavior: pause, log once loudly, then probe on a long escalating cooldown**
  (5 m → 15 m → 30 m → cap 1 h) **forever**; one success closes it. Self-healing matters — a
  breaker that stays open until restarted would have kept the cameras dark after the power-cycle
  that fixed them.
- 🔑 **The failure predicate must be "did not produce a usable result," not "threw."** A breaker
  counting exceptions **would not have tripped once** during this outage: `fetchVideoSource`
  *returns `null`* and `fetchVideoTokenSilent` logs a warning without throwing or emitting `error`.
  To every error path in this codebase, a seven-hour failure looked like a series of successful
  calls returning nothing. Getting this wrong ships a breaker that passes review and sleeps through
  the exact outage it was built for.
