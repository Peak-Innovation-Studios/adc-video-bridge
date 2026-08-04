# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff.

📖 **Narrative history — the WHY — lives in [`Journal.md`](../Journal.md).** Read its most recent
entry for how the current state came about; `grep` for older ones. If it disagrees with this
baton, the baton wins.

---

## Current handoff

- **Last agent:** Claude Code (Opus 5)
- **Updated:** 2026-08-04 — built the ADC API circuit breaker across all three retry loops and
  upstreamed it as [#32](https://github.com/Omar-L/adc-video-bridge/pull/32). Narrative:
  `Journal.md`, entry 2026-08-04; the outage and upstream-PR context is the 2026-08-03 entry.
- **Branch / HEAD:** Run `git fetch && git status -sb && git log --oneline -1`. `main` is the branch
  to deploy from. **Pushing here does NOT deploy** — Kaikoura is updated by hand, and `src/` changes
  need `docker-compose up -d --build`.
  💡 "Do I need a rebuild?" is answerable from git alone: the Dockerfile copies only `package*.json`,
  `tsconfig.json`, `src/` and `entrypoint.sh`, so
  `git diff --name-only <deployed-commit>..main -- <those paths>` empty ⇒ the image is current.
- **Working tree:** Run `git status --short`. No agent has uncommitted work.
- **Validation (this session, on `main`):** `npm run build` clean, `npm test` **11 files / 145 tests**,
  `npm run audit:prod` passed with the documented GHSA-2p57-rm9w-gvfp exception.
- **🔴 Kaikoura is live and streaming, but is NOT running the circuit breaker.** It runs the
  previous image. The breaker touched `src/`, so deploying it needs
  `docker-compose up -d --build` and **David's sudo password**. Nothing about it has executed
  against the live API — its behaviour is asserted by tests only.
  Otherwise unchanged and healthy: go2rtc serves 84–127 KB JPEGs with distinct md5s, a real
  `rtsp+tcp` publisher, and **0** WebSocket 401s (was ~60/hour). Motion, doorbell, audio and HKSV
  remain disabled.
- **Sudo-free diagnosis on Kaikoura:** `node dist/probe.js <cameraId>` and `node dist/discover.js`
  work from the checkout after `set -a; . ./.env; set +a`. Use these instead of `docker exec`, which
  needs David's password. `node_modules`/`dist` there are gitignored.
- **⬆️ EIGHT upstream PRs + two issues open at Omar-L, all awaiting review** (he asked for help
  making the fork more stable). All branch off `upstream/main` and contain **no internal docs**:
  | PR | branch | note |
  |---|---|---|
  | [#23](https://github.com/Omar-L/adc-video-bridge/pull/23) | `upstream-fix/webrtc-track-subscription` | placeholder track wins a one-shot guard |
  | [#24](https://github.com/Omar-L/adc-video-bridge/pull/24) | `upstream-fix/stale-ffmpeg-exit` | **stacked on #23** — conflicts standalone |
  | [#26](https://github.com/Omar-L/adc-video-bridge/pull/26) | `upstream-fix/pin-actions` | CI hardening |
  | [#28](https://github.com/Omar-L/adc-video-bridge/pull/28) | `upstream-fix/network-hardening` | 🔴 **carries `6a4f5a4`** — must not ship without it |
  | [#29](https://github.com/Omar-L/adc-video-bridge/pull/29) | `upstream-fix/log-redaction` | redaction, log level, shutdown |
  | [#30](https://github.com/Omar-L/adc-video-bridge/pull/30) | `upstream-fix/config-validation` | validation + `ADC_*_FILE` |
  | [#31](https://github.com/Omar-L/adc-video-bridge/pull/31) | `upstream-fix/container-hardening` | non-root, read-only, digest pins |
  | [#32](https://github.com/Omar-L/adc-video-bridge/pull/32) | `upstream-fix/circuit-breaker` | closes `#9`; verified 108→136 tests on THEIR tree |
  Issues [#25](https://github.com/Omar-L/adc-video-bridge/issues/25) (measured ~1.2s media gap) and
  [#27](https://github.com/Omar-L/adc-video-bridge/issues/27) (7 production advisories), plus comments
  on `#2`, `#9`, `#11`, and a validation report on
  [AlexxIT/go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130).
  ⚠️ #28 and #23/#24 all touch `camera-stream.ts`, and #32 touches `alarm-event-listener.ts` and
  `camera-manager.ts` — whichever merges last needs a trivial rebase.
  ⚠️ **Never let `docs/AGENT_HANDOFF.md`, `Journal.md`, `CLAUDE.md` or `AGENTS.md` into an upstream
  PR.** `8f88c26` and `baa7ab2` touch the baton and need stripping on cherry-pick.
  🔒 **HELD, not forgotten:** branch `upstream-fix/production-audit-policy` is built and committed
  locally but **deliberately unpushed** — the policy fails on upstream's tree today (see #27). Send
  it once their Dependabot PRs merge.
  ✅ `395d888` is now fully split and upstreamed via #28–#31; only `baa7ab2` (Synology guide) remains
  portable and unsent.
- **🔴 Verify upstream slices against UPSTREAM's lockfile, not ours.** A clean clone with `npm ci`
  from their `package-lock.json` lives in the session scratchpad. Our fork pins `werift ^0.24.2`,
  upstream `^0.19.7`, and **pristine `upstream/main` does not compile against 0.24** — building
  slices in our tree produced a phantom failure and a wrong claim that had to be amended out of a
  PR message.
  ✅ **This rule has now caught a real defect, not just a phantom one.** #32's fixtures used
  `iceServers: []`, which passes here only because our parser has an `Array.isArray` branch;
  upstream `JSON.parse()`s the field directly, so the array threw and hung five tests until vitest's
  5s timeout. **The trap is broader than the werift pin: any fixture exercising code our hardening
  made more tolerant will pass here and fail there.** Fixed on both branches (`e971299`).
- **Whose turn:** **David** — the camera's WiFi (item 1) is the only thing no code can fix, and it
  gates everything else. Secondary David item: deploying the breaker needs a sudo rebuild (item 2).

### What's left (priority order)

1. 🔴 **(David — physical, gates everything)** **The camera's WiFi signal is poor.** It caused the
   2026-08-03 outage and will again; a power-cycle clears the symptom, not the cause. Wired Ethernet
   if the camera supports it, else relocate it or add an AP. Matters more here than for normal use:
   Alarm.com designs for *on-demand* viewing, this bridge holds a **perpetual** session.
2. **(David — sudo)** **Deploy the circuit breaker** — `docker-compose up -d --build` on Kaikoura.
   It is committed on `main` but the running image predates it. ⚠️ Sensible to do *after* item 1, so
   the first live exercise of the breaker is not during a known-bad WiFi window.
3. **(David — 1 min)** `/volume1/homebridge/config.json` is mode **0777** (HomeKit pairing data).
   ⚠️ `chmod` alone will not hold: it is the **volume's default ACL**, and the Homebridge UI rewrites
   the file on every settings change. Durable fix is at the shared-folder/ACL level.
4. **(David, then agent)** **HKSV is now unblocked** — the event stream delivers for the first time.
   Needs `videoConfig.recording: true` + `prebuffer` + `motion` + `porthttp` in Homebridge, the
   bridge's `homebridge.motionUrl` pointed at it, a Homebridge restart, and recording enabled in the
   Home app. ⚠️ Not before item 1.
5. **(Agent — matters most once HKSV is on)** **Make-before-break on token refresh.** Measured
   **~1.2s media gap every 600s**: `reconnect()` closes the old PeerConnection before building the
   new one. The RTSP publisher never drops (ffmpeg spawns once in 30 min), so live view is fine and
   recording is not. Filed upstream as
   [#25](https://github.com/Omar-L/adc-video-bridge/issues/25).
6. *(Agent, low)* go2rtc stream auto-configuration — `config/go2rtc.yaml` is hand-synced with
   `config/config.yaml`. Note `src/discover.ts` already generates both blocks; the job is
   reconciling at startup, not deriving names.
7. *(Agent, low)* Audio passthrough. The peer connection negotiates Opus/PCMU/PCMA but only video is
   subscribed. ⚠️ A camera demoted to Proxy has **no audio at all**, so this only means anything on
   a Direct connection.
8. *(Trivial)* `src/discover.ts` prints `%-20s` literally — `console.log` uses `util.format`, which
   has no printf width specifiers. Cosmetic; the generated YAML is fine.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or
  captured frames. **This applies to this file too.**
- 🧭 **"No video" — diagnose in THIS order. Cheapest and most decisive first.** A full session was
  spent on 2026-08-03 reaching a confident, well-evidenced, *wrong* conclusion by starting at step 3:
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
- 🔑 **Do not "simplify" the circuit breaker to count exceptions.** Its failure predicate is
  *"produced no usable result"* — `token-manager.ts` records a failure on the branch where
  Alarm.com returns HTTP 200 with no WebRTC block, which does **not** throw and does **not** emit
  `error`. That branch is the entire point; a breaker keyed on `catch` sleeps through the outage it
  was built for. Reasoning: `Journal.md` 2026-08-03 and 2026-08-04.
- ⚠️ **Breaker thresholds are coupled to the ladders next to them, and one is deliberately off by
  one.** `STREAM_FAILURE_THRESHOLD` is `BACKOFF_STEPS_MS.length + 1` so the ladder's 10-minute cap
  is used once before the circuit opens; setting it equal to the length makes that rung dead code.
  `TokenManager`'s 600 s `setInterval` must stay **unconditional** — it is the backstop that
  restarts the camera recovery chain after a suppressed fetch, and gating it on circuit state would
  make an open token circuit permanent.
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
  lose the by-digest pin), but the benefit is now established rather than speculative.
  🔴 **Adoption is not a swap — the spike ran on the HOST, not in Docker, which is why it was
  easy.** HomeKit needs mDNS on the real LAN and Docker bridge networking does not forward
  multicast, so a containerised HKSV go2rtc needs `network_mode: host`, `macvlan`, or an mDNS
  reflector. Host networking costs **only** the network-namespace control — read-only rootfs,
  `cap_drop: ALL`, `no-new-privileges`, non-root and digest pinning all survive it. But go2rtc is
  currently **fused into the bridge image** (`alexxit/go2rtc` is the runtime base and
  `entrypoint.sh` starts it), so adopting naively would put the ADC-credential-holding bridge on
  host networking too. **Split go2rtc into its own container first.**
  Spike method, gotchas, and what stayed unmeasured: `Journal.md` 2026-08-03.
  🧹 Spike fully torn down; production untouched. Delete any leftover **"HKSV Spike"** accessory
  from the Home app.
