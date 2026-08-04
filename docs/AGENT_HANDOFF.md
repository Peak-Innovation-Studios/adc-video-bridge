# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff. Narrative history belongs elsewhere.

---

## Current handoff

- **Last agent:** Claude Code (Opus 5), taking over from Codex
- **Updated:** 2026-08-03 — diagnosed and resolved a live "no video" outage. **No code changed.**
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
   There is exponential backoff on dial-in (#5, closed) but nothing ever *gives up*: on persistent
   failure the bridge wakes the camera every ~150s forever. Against an API whose own docs warn
   about aggressive polling, that is how a transient fault becomes self-sustaining.
3. **(Agent-doable)** ADC event WebSocket 401s — ~69 failures/hour, reconnecting every 60s. Costs
   motion events and HKSV triggers. Independent of video; unresolved and undiagnosed.
4. *(Agent-doable, low priority)* go2rtc stream auto-configuration. `config/go2rtc.yaml` stream
   entries are hand-maintained and must be kept in sync with `config/config.yaml`. Note
   `src/discover.ts` **already generates both blocks** from the camera list, so the job is
   reconciling at startup, not inventing name derivation.
5. *(Agent-doable)* Audio passthrough. The peer connection already negotiates Opus/PCMU/PCMA, but
   only the video track is subscribed and the ffmpeg SDP is video-only.
6. *(Trivial)* `src/discover.ts` prints `%-20s` literally — `console.log` uses `util.format`,
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
  Per their [own knowledge base](https://answers.alarm.com/Customer/Website_and_App/Video/Live_Video/View_live_video),
  a Proxy connection *"means that attempts to establish a Direct or Relayed connection have
  failed"*, has a *"time out period of 3 minutes"*, and carries no audio — which is why a
  demoted camera reports `proxyStreamTimeoutTime: 180` and `supportsAudio: false`. Proxy is the
  **failure fallback**, so that `null` means *"Direct has been failing"*. It clears when the
  underlying connectivity problem is fixed. Upstream
  [Omar-L#2](https://github.com/Omar-L/adc-video-bridge/issues/2) frames proxy as an "older camera
  models" issue; that framing is **incomplete** — any camera can be demoted into it.
  ⚠️ **Do not build the Janus proxy path in response to this symptom.** It would permanently adopt
  a 3-minute, audio-less degraded transport to work around a demotion that a power-cycle clears.
- **Do not re-diagnose the "stream dies after ~37s" symptom.** Found and fixed: a stale FFmpeg
  `exit` callback cleared the *replacement* child's reference and fired `onUnexpectedExit`,
  tearing down a healthy session; go2rtc then accumulated two publishers and 248 stuck consumers.
  The fix is two halves that must both survive any refactor — `stop()` detaches ownership *before*
  `SIGTERM`, and the `exit` handler ignores the event unless the exiting child is still the owned
  child. Two regression tests cover it.
- The documented npm audit exception is limited to GHSA-2p57-rm9w-gvfp and is guarded by a check that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the maintained scoped camera package, not the stale unscoped npm package.
- Use the normal Homebridge UI login to install the plugin. Do not mint or reuse internal UI tokens to bypass authentication.
- Ports 8554 and 1984 are authenticated but unencrypted on the LAN; bind only to the intended host address and do not forward them.
- Homebridge `config.json` is mode 600 and a pre-camera mode-600 backup exists at `config.json.bak-adc-camera-20260801-191305`.
- If Synology reports package start failure while the Homebridge user manager has no D-Bus socket, verify Homebridge itself in a bounded foreground run, then recreate only that stale session with `sudo loginctl terminate-user homebridge` before starting the package normally.

### Open decisions

- Whether to enable Alarm.com motion webhooks and HKSV after the live-view pilot is stable.
  ⚠️ Not until the camera's signal problem is addressed — see item 1.
