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
- **Working tree:** `git status --short` **and `git stash list`**. 🔴 **UNCOMMITTED, and it is MINE
  (Claude, this session) — docs only, no `src/` change, no rebuild warranted:** `README.md`,
  `Journal.md`, `docs/INVARIANTS.md`, `docs/AGENT_HANDOFF.md`. Left uncommitted deliberately —
  David had not asked for a commit. Review and commit as one unit; nothing else is in flight.
  ⚠️ The NAS checkout at `/volume1/docker/adc-video-bridge` is a *separate* clone.
- **Validation (re-run before trusting):** `npm run build` clean, `npx vitest run` **16 files / 237
  tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp exception.
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
- **Whose turn:** **DAVID — one decision, then it is the agent's again (item 1).** The spike proved
  the video path; what it cannot decide is whether this project *pivots* to local RTSP (and what
  then happens to the WebRTC half). Item 1a is the fastest route back to working video and needs
  David's sudo regardless.

### What's left (priority order)

1. 🔴 **Adopt local RTSP — the spike is done, the integration is not.**
   ⚠️ Read [`INVARIANTS.md`](INVARIANTS.md) → "What the local-RTSP spike did NOT prove" first; it is
   the full list, and these are its two largest items.
   - **1a. (David — needs sudo; fastest path to video today)** Point go2rtc at a camera directly
     instead of waiting on the bridge. ⚠️ go2rtc's *native* RTSP client was **not** tested against
     the tunnel and probably cannot do it — expect to need an `ffmpeg:` source carrying
     `-rtsp_transport https`. That is a `config/go2rtc.yaml` edit plus a restart, no rebuild.
     🔎 An agent can draft and validate the source string; only the restart needs David.
   - **1b. (Agent — the real work)** A `mobile.alarm.com` client. The endpoints and per-camera
     credentials exist **only** on that API — a legacy RPC-over-HTTP surface (`Action=` form POSTs)
     that nothing in `src/` speaks — and today they come from a saved capture, not from live code.
     ⚠️ Endpoint stability is untested: LAN IPs are DHCP and the ports look UPnP-assigned, so
     "fetch once at startup" may be wrong. Credential rotation is untested too.
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
