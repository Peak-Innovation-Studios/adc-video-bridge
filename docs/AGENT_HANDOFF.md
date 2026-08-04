# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff.

📖 **Narrative history — the WHY — lives in [`Journal.md`](../Journal.md).** Read its most recent
entry for how the current state came about; `grep` for older ones. If it disagrees with this
baton, the baton wins.

---

## Current handoff

- **Last agent:** Claude Code (Opus 5), taking over from Codex
- **Updated:** 2026-08-03 — resolved a live "no video" outage (poor camera WiFi, not our code), and
  measured the streaming pipeline. **No code changed.** Detail: `Journal.md`, entry 2026-08-03.
- **Branch / HEAD:** Run `git fetch && git status -sb && git log --oneline -1`. Everything Codex
  pushed is merged; internal PR
  [#2](https://github.com/Peak-Innovation-Studios/adc-video-bridge/pull/2) is **MERGED**, CI green.
  `main` is the branch to deploy from. Pushing here does **not** deploy — Kaikoura is updated by hand.
- **Working tree:** Run `git status --short`. Only this baton is modified; no other agent has
  uncommitted work.
- **Validation (re-run this session on merged `main`):** `npm run build` clean, `npm test`
  9 files / 116 tests passed, `npm run audit:prod` passed with the documented
  GHSA-2p57-rm9w-gvfp exception.
- **Kaikoura — live and streaming.** `/volume1/docker/adc-video-bridge` is on `main`, migrated off
  the old single-branch checkout, and rebuilt; the FFmpeg-ownership fix has been deployed since the
  2026-08-02 image. Verified end to end this session: go2rtc serves 84–127 KB JPEGs with distinct
  md5s across 30s, and shows a real `rtsp+tcp` publisher (H264 Main L40, bytes climbing). Motion,
  doorbell, audio, and HKSV remain disabled.
- **Host-side dev environment now exists on Kaikoura** (added this session, with David's
  approval): `npm ci && npm run build` has been run in the checkout, so `node dist/probe.js
  <cameraId>` and `node dist/discover.js` work **without sudo** after sourcing `.env`. Both are
  gitignored. Use this for diagnosis instead of `docker exec`, which needs a password.
- **⬆️ Upstream contributions are OPEN and awaiting Omar's review** (2026-08-03, at his request —
  he asked for help making the fork more stable). Both branch off `upstream/main`, touch only
  `src/camera/camera-stream.ts` + tests, and contain **no** internal docs:
  - [Omar-L#23](https://github.com/Omar-L/adc-video-bridge/pull/23) — subscribe to the registered
    WebRTC track, not the placeholder. Branch `upstream-fix/webrtc-track-subscription`.
  - [Omar-L#24](https://github.com/Omar-L/adc-video-bridge/pull/24) — ignore stale ffmpeg exits.
    Branch `upstream-fix/stale-ffmpeg-exit`, **stacked on #23** (they conflict standalone; #23
    landed first and both edit the ffmpeg lifecycle).
  - Findings filed: new issue [#25](https://github.com/Omar-L/adc-video-bridge/issues/25) (the
    ~1.2s media gap), plus comments on `#2` (proxy is a demotion fallback, not an "older models"
    limit) and `#9` (circuit-breaker measurements + the null-vs-throw trap).
  Both `MERGEABLE`; `BLOCKED` = awaiting review. CI has not run — GitHub holds workflows on
  first-time external contributions until a maintainer approves.
  ⚠️ **Never let `docs/AGENT_HANDOFF.md`, `Journal.md`, `CLAUDE.md`, or `AGENTS.md` into an
  upstream PR** — `8f88c26` and `baa7ab2` touch the baton and need stripping on cherry-pick.
  Still portable and un-upstreamed: `3319d75`, `fd3b3dd`, `3ac3b0a`, `baa7ab2`, and `395d888`
  (hardening — 826/-420 across 30 files, split before offering).
- **Whose turn:** **David** — decide what to build next (see "What's left"). Nothing is blocked
  and nothing is broken.

### What's left (priority order)

1. **(David — physical, and the real fix)** **Camera WiFi signal is poor.** That caused today's
   outage and will cause it again. A power-cycle clears the symptom, not the cause. Wired
   Ethernet if the camera supports it; otherwise relocate the camera or add an AP.
   ⚠️ This matters more here than for normal use: Alarm.com designs for *on-demand* viewing,
   while this bridge holds a **perpetual** session. A marginal link that is fine for a 30-second
   app session is structurally unstable for 24/7.
2. **(Agent-doable — now the highest-value code change)** **Add a circuit breaker for ADC API
   calls** — upstream [Omar-L#9](https://github.com/Omar-L/adc-video-bridge/issues/9), still open.
   There is exponential backoff but nothing ever *gives up*. **Measured during this outage:** ~60
   failures/hour from the event WebSocket (backoff caps at 60s) and ~6/hour from the token poller
   (`VIDEO_TOKEN_REFRESH_MS = 600s`, one camera configured). Against an API whose own docs warn
   about aggressive polling, that is how a transient fault becomes self-sustaining.
   📖 **Design decisions are already made — see `Journal.md` before re-litigating them.** Scope is
   all three retry loops; open behavior is pause + self-healing escalating cooldown; and critically
   the failure predicate must be *"did not produce a usable result"*, **not** *"threw"* — a
   breaker counting exceptions would not have tripped once during this outage.
3. **(David — 1 minute, security)** `/volume1/homebridge/config.json` is mode **0777**. This baton
   previously recorded it as 600; it is not. It holds HomeKit pairing data. `chmod 600` — but
   confirm Homebridge still reads it as its own user afterwards.
4. **(Agent-doable)** ADC event WebSocket 401s — ~60 failures/hour, reconnecting every 60s. Costs
   motion events and HKSV triggers. Independent of video; unresolved and undiagnosed.
5. **(Agent-doable — matters most if HKSV is enabled)** **Make-before-break on token refresh.**
   Measured: a **~1.2 s media gap every 600 s**. `reconnect()` closes the old PeerConnection
   *before* building the new one, so ffmpeg receives nothing during the overlap. The RTSP publisher
   itself never drops (`Starting ffmpeg` fires exactly once in 30 min — the seamless-handoff design
   works at the transport layer), but media continuity breaks. Fix: establish the new connection,
   wait for RTP on it, then tear down the old. Invisible to live viewing; recording will notice.
6. *(Agent-doable, low priority)* go2rtc stream auto-configuration. `config/go2rtc.yaml` stream
   entries are hand-maintained and must be kept in sync with `config/config.yaml`. Note
   `src/discover.ts` **already generates both blocks** from the camera list, so the job is
   reconciling at startup, not inventing name derivation.
7. *(Agent-doable)* Audio passthrough. The peer connection already negotiates Opus/PCMU/PCMA, but
   only the video track is subscribed and the ffmpeg SDP is video-only. ⚠️ Note a demoted camera
   on a Proxy connection carries **no audio at all** (`supportsAudio: false`), so this is only
   meaningful while the camera holds a Direct connection.
8. *(Trivial)* `src/discover.ts` prints `%-20s` literally — `console.log` uses `util.format`,
   which has no printf width specifiers. Cosmetic; the generated YAML is unaffected.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or
  captured frames. **This applies to this file too.**
- 🧭 **"No video" — diagnose in THIS order. Cheapest and most decisive first.** A full session was
  spent today reaching a confident, well-evidenced, *wrong* conclusion by starting at step 3:
  1. **Can Alarm.com's own web player AND phone app stream the camera?** If neither can, stop —
     it is not our code. **If they disagree with each other, suspect the network path**, because
     two first-party clients differing cannot be explained by any server-side or protocol theory.
  2. Check camera WiFi signal. Power-cycle it. Re-probe.
  3. Only then read our logs.
- 🔑 **`endToEndWebrtcConnectionInfo: null` does NOT mean Alarm.com dropped end-to-end WebRTC.**
  Proxy is their documented **failure fallback** (3-min timeout, no audio), so that `null` means
  *"Direct has been failing for this camera"* — it clears when connectivity is fixed.
  ⚠️ **Do not build the Janus proxy path in response to this symptom.** Full reasoning, sources,
  and why upstream `Omar-L#2`'s "older camera models" framing is incomplete: `Journal.md`
  2026-08-03.
- **Do not re-diagnose the "stream dies after ~37s" symptom.** Fixed: a stale FFmpeg `exit`
  callback cleared the *replacement* child's reference. Two halves must both survive any
  refactor — `stop()` detaches ownership *before* `SIGTERM`, and the `exit` handler ignores the
  event unless the exiting child is still the owned child. Two regression tests cover it.
- The documented npm audit exception is limited to GHSA-2p57-rm9w-gvfp and is guarded by a check that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the maintained scoped camera package, not the stale unscoped npm package.
- Use the normal Homebridge UI login to install the plugin. Do not mint or reuse internal UI tokens to bypass authentication.
- Ports 8554 and 1984 are authenticated but unencrypted on the LAN; bind only to the intended host address and do not forward them.
- Homebridge `config.json` is mode 600 and a pre-camera mode-600 backup exists at `config.json.bak-adc-camera-20260801-191305`.
- If Synology reports package start failure while the Homebridge user manager has no D-Bus socket, verify Homebridge itself in a bounded foreground run, then recreate only that stale session with `sudo loginctl terminate-user homebridge` before starting the package normally.

### Open decisions

- Whether to enable Alarm.com motion webhooks and HKSV after the live-view pilot is stable.
  ⚠️ Not until the camera's signal problem is addressed — see item 1.
- **Native HKSV via go2rtc — SPIKED AND MEASURED 2026-08-03. Verdict: track, adopt when it ships.**
  HKSV **recording does not re-encode**: 0.7% CPU, ~22 MB RSS, **zero ffmpeg**, muxing fMP4
  in-process. ⚠️ Do **not** repeat the earlier argument that `vcodec: "copy"` makes this
  pointless — `vcodec` governs *live view*, not HKSV recording. Costs unchanged
  ([go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) unmerged/unreleased → self-build,
  lose the by-digest pin), but the benefit is now established rather than speculative. Spike
  method, gotchas, and what stayed unmeasured: `Journal.md` 2026-08-03.
  🧹 Spike fully torn down; production untouched. Delete any leftover **"HKSV Spike"** accessory
  from the Home app.
