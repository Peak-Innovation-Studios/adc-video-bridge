# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff.

📖 **Narrative history — the WHY — lives in [`Journal.md`](../Journal.md).** Read its most recent
entry for how the current state came about; `grep` for older ones. If it disagrees with this
baton, the baton wins.

🔎 **Two files carry what used to bloat this one. Search them; do not read them front to back.**
- [`INVARIANTS.md`](INVARIANTS.md) — what must not be undone, re-diagnosed, or "simplified".
  Read before touching reconnect/session lifecycle, the circuit breaker, or Homebridge on the NAS.
- [`UPSTREAM.md`](UPSTREAM.md) — the Omar-L PR/issue tracker and the rules for contributing there.

---

## Current handoff

- **Last agent:** Claude Code (Opus 5)
- **Updated:** 2026-08-07 (later) — ✅ **THE LOCAL-RTSP SPIKE LANDED.** All three cameras deliver live
  **1920×1080 H.264 with stock ffmpeg**, no cloud, no WebRTC, no video token — including both
  ADC-V515s, which `SupportsWebRTC: false` puts permanently beyond this bridge. Carried as far as a
  live push into the go2rtc `front` stream from Kaikoura, so it meets the downstream half already
  verified 2026-08-06. 📖 Narrative: `Journal.md` 2026-08-07 (later).
  ```
  ffprobe -rtsp_transport https -i "rtsp://<user>:<pass>@<lan-ip>:<port>/s1"
  ```
  🔑 **The scheme and the transport must disagree** — `rtsps://` fails with `404 Stream Not Found`,
  which reads exactly like a wrong path and is not one. Full detail + the two probe readings it
  overturned: [`INVARIANTS.md`](INVARIANTS.md) → "the local port is RTSP tunnelled over HTTPS".
  ⚠️ **It is a spike, not an integration.** What it skipped is written down as a list, and that list
  *is* the backlog: [`INVARIANTS.md`](INVARIANTS.md) → "What the local-RTSP spike did NOT prove".
- **Branch / HEAD:** `git fetch && git status --short && git log --oneline -1`. `main` deploys BY HAND
  over SSH; every `docker-compose` command needs David's sudo password, so an agent cannot rebuild.
  💡 "Do I need a rebuild?" — derive it from the `COPY` lines, not from any summary. The bridge image
  takes `package.json`, `package-lock.json`, `tsconfig.json`, `src/`, `entrypoint.sh`; go2rtc takes
  `patches/` plus a pinned commit. ⚠️ Match by PREFIX (`^src/`), not `^src/$` — that anchor silently
  reports "no change".
- **Working tree:** `git status --short` **and `git stash list`**. Nothing of mine is in flight;
  this session's work is committed and pushed (verified with `git ls-remote origin refs/heads/main`,
  not with the printed push output — RTK has reported "Everything up-to-date" for a push that
  succeeded). ⚠️ Confirm with the commands, not with this line.
  🔴 **`src/` CHANGED this session** (`src/rtsp/tunnel-relay.ts`, `src/config.ts`, `src/index.ts`),
  so the next deploy **DOES need `--build`** — unlike every previous handoff, where a pull was enough.
  ⚠️ Pushing does NOT deploy. The NAS checkout at `/volume1/docker/adc-video-bridge` is a *separate*
  clone and must be pulled and rebuilt by hand.
- **Validation (re-run before trusting):** `npm run build` clean, `npx vitest run` **17 files / 261
  tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp exception.
  🔑 The relay's three structural guards were **mutation-checked**, not just written: reverting each
  one kills its own test and leaves the rest green — which is the point, because the base64 bug
  passes 8 of 12 tests including the whole handshake.
- ✅ **Bridge RUNNING, deployed build current.** Expected healthy-but-blocked reading: `state: idle`,
  `tokenFailures` climbing to 3 over ~20 min, then `tokenCircuit: open` — the breaker working, not a
  fault. ⚠️ A stopped bridge and a broken camera look identical from outside; confirm it is up first:
  `curl -s -o /dev/null -w '%{http_code}' http://192.168.7.42:9090/` → `401` means running.
  ⚠️ Never infer the deployed version from the host `dist/` (the Dockerfile builds *inside* the image):
  `sudo docker exec adc-video-bridge ls dist/utils/table.js`. `src/` has since changed by **comments
  only** — no rebuild warranted. This NAS has **Compose v1** (`docker-compose`, hyphen).
- ✅ **The whole DOWNSTREAM half is verified end to end (2026-08-06)** with a synthetic colour-bars
  stream, no camera needed: RTSP ingest → go2rtc → HAP → live SRTP (`fmt=homekit proto=rtp medias=3`)
  → picture in the Home app. 🔑 So when video returns, **nothing downstream has to work for the first
  time.** Reusable recipe: [`INVARIANTS.md`](INVARIANTS.md) → "Smoke-test the whole downstream half".
- 🔑 **THE STATUS ENDPOINT IS THE FIRST THING TO CHECK — no sudo needed.**
  ```
  curl -s --user "$STATUS_USERNAME:$STATUS_PASSWORD" http://192.168.7.42:9090/ | jq
  ```
  (credentials in `.env` on the NAS). Per-camera state plus, for **each** breaker, its own circuit,
  failure count and cooldown. 🔎 Three of its fields are routinely misread — see
  [`INVARIANTS.md`](INVARIANTS.md) → "Reading the status endpoint" before drawing conclusions.
- 🔴 **BLOCKER (Alarm.com's side, real, but NOT the only route): no end-to-end WebRTC for web/API
  clients.** All 3 cameras return `endToEndWebrtcConnectionInfo: null` with `errorEnum: 0`. Ruled out
  by measurement — per-camera state, our code (bridge stopped ~55 min), CGNAT, symmetric NAT (STUN:
  same mapped port to 4 destinations), camera power-cycle, and browser environment.
  🔑 **ARTIFACT TO READ OUT:** their **own web player** calls the same endpoint and gets the same null
  block, then falls back to Janus proxy and times out at 3 min — *"The stream has timed out."*
  Their **mobile** API mints signalling tokens for the same camera at the same moment.
  ➡️ **ASK:** *"clear/reset the Direct-vs-Proxy determination for these cameras — and why does the web
  API issue no e2e config when the mobile API does?"*
  🔴 **Do NOT build the Janus proxy path** ([`INVARIANTS.md`](INVARIANTS.md); Omar-L#2).
- 🔴 **NEVER commit** credentials, MACs, LAN/WAN IPs, session tokens, camera **names** or IDs from the
  Proxyman captures. `CLAUDE.md` forbids it; camera names were committed in error earlier this session
  and removed from current content (they remain in history).
- **Sudo-free diagnosis on Kaikoura:** the status endpoint above, then `/usr/local/bin/node
  dist/probe.js <cameraId>` after `set -a; . ./.env; set +a`. 🔎 `node` is NOT on a non-interactive ssh
  PATH — full path required. ⚠️ **Do not `setsid`/`nohup` detach long runs; hold the ssh connection.**
- **⬆️ Omar-L merged #26 and #29; six PRs still open.** 🔴 **Do NOT "sync fork"** — it conflicts in 3
  files and gains nothing. Wait for all six, reconcile once: [`UPSTREAM.md`](UPSTREAM.md).
- **Whose turn:** 🔴 **DAVID — item 1a, and it is the only thing between here and working video.**
  The code is written, tested and live-fired against real cameras; what is left is filling in three
  config files with values only David holds (they are in the Proxyman captures) and one
  `docker-compose up -d --build`, which needs his sudo. Everything else in the backlog is optional
  or follows from that.

### What's left (priority order)

1. 🔴 **Adopt local RTSP — the spike is done, the integration is not.**
   ⚠️ Read [`INVARIANTS.md`](INVARIANTS.md) → "What the local-RTSP spike did NOT prove" first; it is
   the full list, and these are its two largest items.
   - ✅ **1a′. DONE — the relay is BUILT and live-fired.** `src/rtsp/tunnel-relay.ts`, enabled per
     camera with a `localRtsp` block. Measured against a real camera and the real pinned go2rtc:
     **61.9 s of continuous 1920×1080 H.264, 17.3 MB through go2rtc's own muxer, 0 ffmpeg
     processes.** Recipe: [`SETUP.md`](SETUP.md) → "Step 2b". Design + the five traps:
     [`INVARIANTS.md`](INVARIANTS.md) → "Two ways to feed go2rtc from the tunnel", Option B.
   - 🔴 **1a. (DAVID — needs sudo; this is the whole remaining gap to live video.)** Fill in
     `config/config.yaml` (`localRtsp` per camera), `.env` (`ADC_BRIDGE_RTSP_PORTS`) and
     `config/go2rtc.yaml` (stream URL with the CAMERA's credentials), then
     **`docker-compose up -d --build`** — `src/` changed, so this one does need a rebuild.
     ⚠️ The endpoint values are in David's Proxyman captures and must never reach the repo.
     💡 Option A (an `ffmpeg:` source, config-only, no rebuild) is still documented as the zero-code
     fallback if the relay misbehaves.
   - **1b. (Agent — but the case for it WEAKENED 2026-08-07)** A `mobile.alarm.com` client. The
     endpoints and per-camera credentials exist **only** on that API — a legacy RPC-over-HTTP surface
     (`Action=` form POSTs) that nothing in `src/` speaks — so today they are typed in by hand.
     🔑 **A camera's port survived an IP change**, so ports are device-assigned rather than
     lease-derived, and the IPs are now pinned by DHCP reservation. Both halves of the endpoint are
     therefore stable under the drift we have actually observed.
     ❓ **One unknown left, and it decides this item: does the port survive a camera REBOOT?**
     One power-cycle answers it. If it holds, this client may never be needed.
     ⚠️ It is also not cheap: the captures hold no login exchange, so it starts with obtaining one,
     and carries account-lockout risk. Do the power-cycle test first.
     💡 What IS worth building either way: a consistency check that `localRtsp.listenPort`,
     `ADC_BRIDGE_RTSP_PORTS` and the `go2rtc.yaml` stream names agree — today they can disagree
     silently and the stream just reports offline.
   - **1c. (David — after 1a)** **Pair the two new cameras by hand in the Home app.** Each go2rtc
     camera is its own HomeKit accessory with its own PIN; nothing is inherited from Homebridge or
     from the already-paired one.
   🔑 If this lands it removes the cloud dependency, the token refresh, the proxy demotion and this
   entire outage — and it is the **only** possible path for the two ADC-V515s.
   ⚠️ No credentials, MACs, IPs, tokens or camera names into the repo, ever.
2. 🔴 **(BRINKS — virtual technician session being scheduled; still a real defect on their side)** Alarm.com issues no
   end-to-end WebRTC config for **any** camera on the account (3 of 3, two models, two of them added
   2026-08-06 and never touched by our code). Proxy still works, so the cameras are online. Nothing
   in our code can fix it and nothing further is worth measuring from our side. ⚠️ **No longer the
   critical path** — item 1 routes around it entirely, and cannot help the two V515s regardless.
   Full evidence in the blocker above.

2b. 🔴 **(David — a decision, not code)** `PublicRtspEndpoint` publishes each camera's port on the
   **WAN** address: digest-auth RTSP behind a self-signed certificate that expired Dec 2024,
   reachable from the internet, almost certainly created by UPnP. Found in passing 2026-08-07; not
   probed from outside. Worth deciding on deliberately rather than inheriting.
3. 🔴 *(Agent — BLOCKED on video; both need a real camera to pick a timeout)* **Two observability
   defects, found 2026-08-06. Both let a dead stream look calm:**
   - **No media watchdog after `SESSION_STARTED`** — a trackless session is recorded as a *success*
     (`breaker.recordSuccess()`), resetting the breaker that should catch it, and `state` sits at
     `'connecting'` forever. Fix shape: fail the attempt if no track arrives within N seconds.
   - **A camera never attempted reports `idle` with zero errors** for ~30 min, until the token
     breaker opens (`VIDEO_TOKEN_FAILURE_THRESHOLD = 3` × `VIDEO_TOKEN_REFRESH_MS = 600s`).
   🔑 Both are the trap `README.md` documents one layer up — *"did not produce a usable result"* is
   the failure, not *"threw"* — never applied downward. 📖 Reasoning: `Journal.md` 2026-08-06.
4. *(Agent — do this when video returns)* **Verify HKSV actually RECORDS without transcoding.**
   ⚠️ Live view and the whole downstream path are already verified (2026-08-06, synthetic stream);
   what remains unproven is motion-triggered *recording*:
   `[hksv] flush fragment` lines with sequential `seq` and ~67 KB fragments, an `hksv` consumer
   alongside `homekit` from one producer, and **no ffmpeg beyond the bridge's one**. Compare against
   the spike's 0.7% CPU / ~22 MB.
5. *(David — after 4 verifies)* **Remove the Homebridge camera accessory** and its config. Until
   then both accessories exist deliberately — that is the documented cutover.
6. **(David — 1 min)** `/volume1/homebridge/config.json` is **775**; world-read remains, and
   `INVARIANTS.md` sets 600 as the standard. ⚠️ Re-check after any Homebridge settings change: the
   volume's default ACL is 0777 and the UI rewrites the file.
7. *(Agent, low)* **A/B `-reorder_queue_size 0`** — production logs show repeated
   `Non-monotonic DTS ...`. Test only once video is stable, or it measures the link.
8. *(Agent, low)* go2rtc stream auto-configuration; `src/discover.ts` already generates both blocks.
9. *(Agent, low)* Audio passthrough. ⚠️ A camera on Proxy has no audio at all.
10. *(Agent — BLOCKED on video, do not fix blind)* `onFailed` fires on `'disconnected'` as well as
   `'failed'` ([`peer-session.ts:235`](../src/camera/peer-session.ts)), so a transient ICE blip
   forces a full teardown. `'disconnected'` is the recoverable state in WebRTC and `'failed'` the
   terminal one, so the shape of the fix (debounce, and act only if it has not recovered) is not in
   doubt — but the timeout is a *tuning* value, and choosing it without a real camera would be
   guessing. ⚠️ Deliberately not attempted 2026-08-05.
   ✅ The other four deferred review nits are **DONE** (2026-08-05): dead `'fallback'` member of
   `OverlapOutcome` removed; the false "activeDied cannot be true here" comment in `reconnect()`
   corrected; `rtpCount` now reset in `cutOver()`; `tryConnect()` sets `_state = 'error'` on
   rejection instead of stranding it at `'connecting'`.
11. ✅ **DONE (2026-08-05)** — `src/discover.ts` printed `%-20s` literally (`util.format` has no
    width syntax). Now uses a tested `src/utils/table.ts`.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or
  captured frames. **This applies to this file too.**
- 🔎 **Everything else that used to be listed here now lives in [`INVARIANTS.md`](INVARIANTS.md)** —
  the "no video" diagnosis order, the `endToEndWebrtcConnectionInfo: null` trap, the ~37s
  stale-callback fix, session-callback ownership, the two circuit-breaker rules, and the Homebridge
  and Synology invariants. **Search it before changing any of those.**

### Open decisions

- **Report the HAP auth defect upstream** on [go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130).
  It is a real design gap, not a misconfiguration: HAP structurally cannot send Basic credentials, so
  serving it behind that middleware makes native HomeKit unusable for anyone with API auth on — and it
  fails silently, since the accessory registers, advertises and returns a valid setup code first.
- **Whether to keep the Homebridge accessory** once native HKSV is verified recording. The plan says
  remove it; that is item 3 and needs video first.
- ✅ **RESOLVED — native HKSV is adopted, not tracked.** The old "track, adopt when it ships" verdict
  is superseded: it is built from a pinned fork commit, deployed and paired. The revert trigger
  (return to the official digest-pinned image when #2130 ships) is in
  [`INVARIANTS.md`](INVARIANTS.md).
