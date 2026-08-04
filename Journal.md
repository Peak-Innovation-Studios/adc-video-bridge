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

### Native HKSV via go2rtc — SPIKED AND MEASURED, and the initial assessment was wrong

**Correcting the section below.** It argued against native HKSV partly on "we already do not
re-encode, because `vcodec: \"copy\"`". That reasoning was **wrong**: `vcodec` governs the
**live-view** path, not HKSV *recording*, which is a separate path in `camera-ffmpeg` with much
harder constraints (fragmented MP4, GOP alignment, strict profile/level) — exactly the constraints
that normally force a transcode. Generalising from one config key to a feature it does not govern
nearly talked us out of a real improvement.

So we spiked it. Findings, measured on Kaikoura against the live camera:

| | idle | live view | **HKSV recording** |
|---|---|---|---|
| go2rtc CPU | 0.4% | 0.4% | **0.7%** |
| RSS | 23 MB | 22 MB | **21–22 MB** |
| ffmpeg processes | 0 | 0 | **0** |

**Native HKSV recording does not re-encode.** The debug log shows `[hksv] flush fragment
fragSize≈67000` once per second with sequential `seq` numbers (≈536 kbps, consistent with 1080p10
H.264 straight through), and a third consumer appears with `format_name: "hksv"` alongside the
live `homekit` one, both fed from a single `rtsp` producer. It muxes rather than encodes, as
`pkg/hksv`'s README claims — now verified on our hardware.

Also learned: HomeKit negotiated 1280x720@30 while the source is 1920x1080@10, and **accepted the
mismatch** without transcoding. The same tolerance explains why the Homebridge path works despite
`maxWidth`/`maxHeight` being inert under `vcodec: "copy"`.

**How the spike was run** (repeat this way — it was cheap and completely isolated): go2rtc is a
single static Go binary and cross-compiles trivially, so there was **no Docker image, no sudo, and
no change to the deployment**. Built `skrashevich/go2rtc@hksv` with
`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`, copied the 19 MB binary to the NAS, ran it as `dpeak` on
spare ports (1985/8555) pulling the RTSP stream the production go2rtc already publishes. Running
on the host rather than in a container also made HomeKit's mDNS advertisement work for free —
the awkward part of running HAP in Docker. Teardown was `kill` + `rm -rf`. `pkg/hksv` and
`internal/homekit` unit tests pass.

⚠️ Gotchas hit while spiking, worth not rediscovering:
- `pkg/hksv` hardcodes the pairing pin to **`27041991`** when unset — publicly documented, so
  always set a random `pin:`.
- `pkg/hksv/hksv.go:293` logs `ERR ... error=EOF` on an aborted pair-setup attempt even when
  pairing then succeeds. Log noise, not a fault.
- `pkill -f "go2rtc -config ..."` **matches its own ssh command line** and kills the session
  before doing anything. Resolve the PID with `ps` and kill that instead.
- `scp` resolves `kaikoura` differently than `ssh` does (the `Match exec` block in
  `~/.ssh/config`); pipe over `ssh 'cat > file'` instead.

**What is still unmeasured:** what HKSV *recording* costs on the Homebridge path. It was never
enabled there (`videoConfig.recording` defaults to `false`, and that camera has no `motion` key),
and measuring it would have required a production config edit plus a Homebridge restart that
interrupts unrelated accessories. Deliberately skipped: the direction of the result does not change
the decision, only its margin.

**Revised position:** the benefit is now **established rather than speculative**, but the *costs*
are unchanged — [go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is still unmerged and
unreleased, so adopting it in production means self-building from a branch and giving up the
Dockerfile's by-digest pin. Track it; adopt when it merges and ships. The reasoning in the
superseded section below is retained only to show what the wrong argument looked like.

### Native HKSV via go2rtc — the original (superseded) assessment

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

### Upstream contribution — Omar asked, so we shipped what we had

Omar (upstream maintainer) reached out asking how the fork was going, *"especially if you can make
it run more stable."* The fork was **12 commits ahead, 0 behind** — a clean superset — and two of
those commits were exactly that.

Opened `Omar-L#23` (track subscription) and `Omar-L#24` (stale ffmpeg exit, stacked on #23).
They had to stack: cherry-picking the ffmpeg fix alone onto `upstream/main` conflicts, because
both edit the ffmpeg lifecycle and the track fix landed first.

**Both bugs are the same shape**, which is worth carrying forward as a review lens: *a reference
held without asking which instance it points to.* One is a placeholder track winning a one-shot
guard the real track needed; the other is a dead process's callback mutating state belonging to
its replacement. Object-lifecycle identity confusion, twice.

Also filed `#25` (the ~1.2s media gap, with measurements) and commented on `#2` and `#9` rather
than opening duplicates — `#2`'s "older camera models" framing needed the correction that any
camera can be demoted into proxy, and `#9` needed the failure-rate data plus the null-vs-throw
trap.

Deliberately **not** upstreamed yet: the hardening commit (`395d888`, 826/-420 across 30 files)
needs splitting into reviewable pieces first. Everything else portable is small and can follow.

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
