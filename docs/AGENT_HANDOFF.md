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
- **Updated:** 2026-08-07 (night) — ✅ **VIDEO IS BACK, HKSV RECORDS, AND ALARM.COM IS OUT OF THE
  VIDEO PATH ENTIRELY** — streaming, tokens and motion. `motion: detect` makes go2rtc detect
  motion from the H.264 stream itself, so no notification rule is needed on their side.
  ⚠️ Motion thresholds are **measured but unconfirmed over a full night** — item 2, and
  `log: { homekit: trace }` is still enabled for that measurement.
  🔑 **The community/adoption gap is nearly closed** — the mobile API login is captured and a
  client is built (`npm run discover:local`); it needs ONE successful live sign-in. Item 3. 📖 `Journal.md` 2026-08-07 (night).
- **Previously (evening):** ✅ **THE OUTAGE ENDED.** All three cameras
  are live in HomeKit over their own **local RTSP**, pulled by go2rtc's **native** client and muxed to
  HKSV in process — **zero ffmpeg in the media path**. The two ADC-V515s work for the first time ever;
  `SupportsWebRTC: false` had put them permanently beyond this bridge. The Alarm.com WebRTC blocker is
  real and unchanged, and no longer on the critical path.
  📖 Narrative: `Journal.md` 2026-08-07 (evening).
- **How it works now:** `src/rtsp/tunnel-relay.ts` presents each camera's RTSP-over-HTTPS tunnel as
  ordinary RTSP on a published port; go2rtc pulls it. Enabled per camera by a `localRtsp` block.
  🔑 A camera with `localRtsp` is **excluded from the WebRTC path** — both publish into the same
  go2rtc stream name, and running both interleaves rather than erroring.
  Design + the six traps: [`INVARIANTS.md`](INVARIANTS.md) → "Two ways to feed go2rtc from the
  tunnel". Runbook: [`SETUP.md`](SETUP.md) → "Step 2b".
- 🔑 **RUN THIS BEFORE DEBUGGING ANY CONFIG PROBLEM — it is new, and it exists because of this
  session's mistakes:**
  ```
  ssh kaikoura 'cd /volume1/docker/adc-video-bridge && export PATH=/usr/local/bin:$PATH && \
    npm run verify:config --silent -- .'
  ```
  Checks the seams BETWEEN `config.yaml`, `go2rtc.yaml` and `.env`, which no single file's validation
  can see: unpublished relay ports, `homekit:` blocks with no matching stream, duplicate YAML keys,
  empty stream sources, pin rules, wildcard binds. Exits non-zero on anything blocking. No sudo.
  🔑 **The NAS carries the full devDependencies, so every `tsx` CLI runs THERE, in place** —
  `verify:config`, `homekit:label`, `discover`, `probe`. ⚠️ `npm` is not on a non-interactive ssh
  PATH any more than `node` is; export `/usr/local/bin` or the command is simply "not found".
- **Branch / HEAD:** `git fetch && git status --short && git log --oneline -1`. `main` deploys BY HAND
  over SSH; every `docker-compose` command needs David's sudo password, so an agent cannot rebuild.
  💡 "Do I need a rebuild?" — derive it from the `COPY` lines, not from any summary. The bridge image
  takes `package.json`, `package-lock.json`, `tsconfig.json`, `src/`, `entrypoint.sh`; go2rtc takes
  `patches/` plus a pinned commit. ⚠️ Match by PREFIX (`^src/`), not `^src/$` — that anchor silently
  reports "no change".
- **Working tree:** `git status --short` **and `git stash list`**. Nothing of mine is in flight;
  committed and pushed (verify with `git ls-remote origin refs/heads/main`, **not** the printed push
  output — RTK has reported "Everything up-to-date" for a push that succeeded).
  ⚠️ Pushing does NOT deploy. The NAS checkout at `/volume1/docker/adc-video-bridge` is a *separate*
  clone, pulled and rebuilt by hand. ⚠️ **Compose is v2.20.1**, despite the hyphenated
  `docker-compose` binary name — an earlier baton said v1, which was wrong. All v2 flags work
  (`--since`, `--index`).
- **Validation (re-run before trusting):** `npm run build` clean, `npx vitest run` **23 files / 357
  tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp exception.
  🔑 The relay's structural guards were **mutation-checked**, not just written: reverting each kills
  its own test and leaves the rest green. ⚠️ Calibration — the base64 bug passes **8 of 12** tests
  including the entire handshake. A passing handshake test proves nothing here.
- ✅ **ALL THREE CAMERAS PAIRED AND PERSISTED** (2026-08-07 18:59). Confirmed on disk, not inferred:
  `pairings:` present for all three in `config/go2rtc.yaml`, mode still 600 after go2rtc rewrote it.
  🔴 **A pairing that is not in that file exists in MEMORY ONLY and dies on restart** — see
  [`INVARIANTS.md`](INVARIANTS.md) → "ONE duplicate YAML key ... disables EVERY config write". That
  is what an accessory stuck on **"Connecting…"** means.
- ✅ **DEPLOYED AND HEALTHY.** Confirmed by measurement, not inference: three relays `listening: true`
  having served real traffic, `producers=1` on all three go2rtc streams, and all three HomeKit
  accessories advertising over mDNS (`dns-sd -B _hap._tcp local`) and paired.
  ⚠️ `connections: 0` and `consumers: 0` on an idle system is **correct** — go2rtc pulls lazily and
  disconnects when nothing is watching. It is not a fault.
- 🔑 **PAIRING NEEDS NO CLI:** `http://<bind>:9090/pair` serves scannable setup codes per camera,
  behind the status endpoint's own credentials. 🔑 Codes come from **go2rtc's API**, never from
  `config/go2rtc.yaml` — the bridge cannot read that file, and go2rtc stops publishing a code once
  an accessory is paired, so the exposure window closes itself. Printable version:
  `npm run homekit:label`.
- 🔑 **THE STATUS ENDPOINT IS THE FIRST THING TO CHECK — no sudo needed.** Now includes `relays` and
  `events`. 🔑 **`events.messagesReceived` answers "is motion working?"** — it separates "Alarm.com is
  sending nothing" from "events arrive but none are motion". ⚠️ `events.connected: true` is NOT
  evidence that events flow; the socket ran healthy for 76 minutes delivering nothing.
  ```
  ssh kaikoura 'cd /volume1/docker/adc-video-bridge && set -a && . ./.env && set +a && \
    curl -s --user "$STATUS_USERNAME:$STATUS_PASSWORD" http://192.168.7.42:9090/'
  ```
  ⚠️ `$STATUS_USERNAME` only expands if `.env` is sourced, and there is **no `jq` on the NAS** — pipe
  it back to the Mac. 🔎 Three of its fields are routinely misread — see [`INVARIANTS.md`](INVARIANTS.md)
  → "Reading the status endpoint" before drawing conclusions.
- 🔴 **TRIAGE RULE, learned the hard way: port 9090 REFUSING means the BRIDGE IS DOWN — stop looking
  at relay ports.** A config error and an unpublished port are indistinguishable from a client; both
  present as `Connection refused` on 8561-8563 with nothing mentioning the real cause. If 9090 answers
  401 but a relay port refuses, *then* suspect `ADC_BRIDGE_RTSP_PORTS`.
  ⚠️ The bridge can crash-loop **after** logging three healthy `RTSP tunnel relay listening` lines and
  a successful Alarm.com login. The logs read as a clean startup right up to the fatal.
- ⚠️ **The Alarm.com WebRTC defect is unchanged and still real** — all 3 cameras return
  `endToEndWebrtcConnectionInfo: null` with `errorEnum: 0`, their own web player times out at 3
  minutes, their mobile API mints signalling tokens for the same camera at the same moment. It is
  simply **no longer blocking anything**. Full evidence in `Journal.md` 2026-08-06/07.
  🔴 **Do NOT build the Janus proxy path** ([`INVARIANTS.md`](INVARIANTS.md); Omar-L#2).
- 🔴 **NEVER commit** credentials, MACs, LAN/WAN IPs, session tokens, camera **names** or IDs from the
  Proxyman captures. ⚠️ **A leak check that reports without BLOCKING is not a check** — a fixture
  carrying the real camera username was committed this session while the scan printed the finding and
  the commit proceeded anyway. Camera names were committed in error earlier too. Both remain in history.
- 🔴 **UNPUSHED WORK ON A BRANCH.** An unattended session committed 5 commits to
  **`docs/community-onboarding`** (branched from `37d1236` on `main`). Docs plus one small
  `verify:config` change; **no `src/` runtime change**, so no rebuild is needed to merge it.
  ⚠️ Nothing was pushed and nothing was deployed — both are on the STOP list for unattended runs.
  Review, then merge/push at will.
- **Whose turn:** **DAVID.** Nothing is broken; video and recording both work. In order:
  **(a)** review and push the branch above; **(b)** decide the motion-threshold approach (item 2);
  **(c)** the one capture that unblocks community adoption (item 3).

### What's left (priority order)

1. ✅ **DONE — local RTSP is ADOPTED and deployed.** All three cameras live in HomeKit via
   `src/rtsp/tunnel-relay.ts`, go2rtc's native client, in-process HKSV, no ffmpeg. Both V515s work.
   Runbook: [`SETUP.md`](SETUP.md) → "Step 2b". Design + traps: [`INVARIANTS.md`](INVARIANTS.md).
   ⚠️ What it still does NOT do: fetch its own endpoints (item 3), and prove HKSV *records* (item 2).

2. ⚠️ **Motion works; thresholds are MEASURED but not yet confirmed over a full night.**
   ✅ HKSV recording is proven and all three cameras use `motion: detect`, so Alarm.com is out
   of the loop. Current values: front 4.5, kitchen 5.5, sunroom 3.5.
   🔑 **Measured 2026-08-07 via `log: { homekit: trace }`:** idle `ratio` sits at **0.68-1.22**
   across all three, against baselines of ~1720 / ~1200 / ~700. That is 3-4.5× headroom, and no
   trigger fired during the sample. **An earlier "false positives" reading was wrong** — those
   counts came from a window whose occupancy was never verified, and were probably real motion.
   ⚠️ `motion: status` samples 1 frame in 150 — it shows the noise FLOOR, never the spikes that
   trigger. Only a `motion: ON` line carries a trigger's ratio.
   ➡️ **Next: check the Home app timeline after a night with the house empty.** Clips at 3am =
   false positives, raise. No clips = these values are right, and could even come down for
   sensitivity.
   🔴 **`log: { homekit: trace }` is TEMPORARY and still enabled** — remove it and restart
   go2rtc once the thresholds are settled.

3. 🔴 **(THE community blocker — BUILT, one controlled sign-in from done.)** A
   `mobile.alarm.com` client so endpoints and per-camera credentials are fetched rather than
   typed in by hand. 📄 **Full detail: [`MOBILE_API.md`](MOBILE_API.md).**
   ✅ **Captured and implemented 2026-08-07:** `POST /MobileServlet/SubmitRequest.aspx`,
   `Action=UberLoginNew`, password in PLAINTEXT, and the response `<lnr>` **contains the
   cameras** — `<cli>` elements carry `lre` (local RTSP), `l`/`p` credentials, and
   `UnitId`+`did` which reconstruct the web API's camera id. No second call needed.
   Built: `src/mobile/mobile-api.ts` + `npm run discover:local`, which prints paste-ready
   blocks for all three config files.
   ❓ **A live sign-in has NOT yet succeeded, and the evidence is contaminated.** ~9 attempts
   were made in one evening; the FIRST returned a parseable `<lnr lr="1">`, and **every one
   after returned an empty body regardless of what was varied** — including the app's exact
   captured field set. 🔑 **That fits RATE LIMITING, not field validation**, so the conclusions
   drawn from the later attempts are unreliable.
   ➡️ **Next: wait several hours for a cold start, then make ONE attempt** with the captured
   `ADC_MOBILE_DEVICE_UID`, `ADC_MOBILE_TWO_FACTOR_ID` and `ADC_MOBILE_HASH_CODE`, and judge
   from that single result. 🔴 **Do not permute** — that is what produced the noise.
   🔎 Three traps already paid for: a minimal field set returns a non-`<lnr>` body with no
   error; the response is **gzipped and `fetch` does not decode it**; and a REJECTED login
   still returns HTTP 200, so only `lr` distinguishes success.

4. **(David — a decision, not code)** `PublicRtspEndpoint` publishes each camera's port on the **WAN**
   address: digest-auth RTSP behind a self-signed certificate that expired Dec 2024, reachable from
   the internet, almost certainly created by UPnP. Not probed from outside. Worth deciding on
   deliberately rather than inheriting. ⚠️ More pointed now that local RTSP is the production path.

5. **(Agent, small)** `api.local_auth: false` in the deployed `config/go2rtc.yaml`; the example and
   `SECURITY_AUDIT.md` both specify `true`. Exposure is nil today only because `api.listen` is the LAN
   address — so the protection comes from the bind address, not the setting. `npm run verify:config`
   warns about it.

6. **(Agent, small)** Make the pre-commit leak scan **BLOCK** rather than report. A fixture carrying
   the real camera username was committed this session while the scan printed the finding and the
   commit proceeded anyway.

7. ⚠️ **(BRINKS — technician session still pending; a real defect on their side, no longer blocking)** Alarm.com issues no
   end-to-end WebRTC config for **any** camera on the account (3 of 3, two models, two of them added
   2026-08-06 and never touched by our code). Proxy still works, so the cameras are online. Nothing
   in our code can fix it and nothing further is worth measuring from our side. ⚠️ **No longer the
   critical path** — item 1 routes around it entirely, and cannot help the two V515s regardless.
   Full evidence in the blocker above.

8. *(Agent — now UNBLOCKED, a real camera is available)* **Two observability
   defects, found 2026-08-06. Both let a dead stream look calm:**
   - **No media watchdog after `SESSION_STARTED`** — a trackless session is recorded as a *success*
     (`breaker.recordSuccess()`), resetting the breaker that should catch it, and `state` sits at
     `'connecting'` forever. Fix shape: fail the attempt if no track arrives within N seconds.
   - **A camera never attempted reports `idle` with zero errors** for ~30 min, until the token
     breaker opens (`VIDEO_TOKEN_FAILURE_THRESHOLD = 3` × `VIDEO_TOKEN_REFRESH_MS = 600s`).
   🔑 Both are the trap `README.md` documents one layer up — *"did not produce a usable result"* is
   the failure, not *"threw"* — never applied downward. 📖 Reasoning: `Journal.md` 2026-08-06.
9. *(David — after item 2 verifies)* **Remove the Homebridge camera accessory** and its config. Until
   then both accessories exist deliberately — that is the documented cutover.
10. **(David — 1 min)** `/volume1/homebridge/config.json` is **775**; world-read remains, and
   `INVARIANTS.md` sets 600 as the standard. ⚠️ Re-check after any Homebridge settings change: the
   volume's default ACL is 0777 and the UI rewrites the file.
11. *(Agent, low)* **A/B `-reorder_queue_size 0`** — production logs show repeated
   `Non-monotonic DTS ...`. Test only once video is stable, or it measures the link.
12. *(Agent, low)* go2rtc stream auto-configuration; `src/discover.ts` already generates both blocks.
13. *(Agent, low)* Audio passthrough. ⚠️ **The local RTSP stream has no `m=audio` line at all**,
    so on this path audio is not merely unimplemented — the camera does not send it.
14. *(Agent — WebRTC path only; unblocked but low value now)* `onFailed` fires on `'disconnected'` as well as
   `'failed'` ([`peer-session.ts:235`](../src/camera/peer-session.ts)), so a transient ICE blip
   forces a full teardown. `'disconnected'` is the recoverable state in WebRTC and `'failed'` the
   terminal one, so the shape of the fix (debounce, and act only if it has not recovered) is not in
   doubt — but the timeout is a *tuning* value, and choosing it without a real camera would be
   guessing. ⚠️ Deliberately not attempted 2026-08-05.
   ✅ The other four deferred review nits are **DONE** (2026-08-05): dead `'fallback'` member of
   `OverlapOutcome` removed; the false "activeDied cannot be true here" comment in `reconnect()`
   corrected; `rtpCount` now reset in `cutOver()`; `tryConnect()` sets `_state = 'error'` on
   rejection instead of stranding it at `'connecting'`.

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
