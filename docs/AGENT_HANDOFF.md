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
- **Updated:** 2026-08-06 — Deferred review nits cleared and deployed. **There is still no video, and
  the failure MOVED during 2026-08-05/06** — it is no longer "never dials in". See the blocker below;
  the old wording is now wrong in a way that would misdirect a support call. Narrative: `Journal.md`.
- **Branch / HEAD:** `git fetch && git status -sb && git log --oneline -1`. `main` deploys by hand.
  💡 "Do I need a rebuild?" is answerable from git: the Dockerfile copies only `package*.json`,
  `tsconfig.json`, `src/`, `patches/` and `entrypoint.sh`.
- **Working tree:** `git status --short` **and `git stash list`**. Both empty at handoff — and the
  NAS checkout at `/volume1/docker/adc-video-bridge` is a *separate* clone that is also pulled to
  `main`; changing files there is not the same as changing them here.
- **Validation (re-run before trusting):** `npm run build` clean, `npx vitest run`
  **16 files / 236 tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp
  exception.
- ✅ **DEPLOYED on Kaikoura and VERIFIED CURRENT (2026-08-06).** Do not trust a remembered commit —
  the host `dist/` is stale by design (the Dockerfile builds *inside* the image), so it proves
  nothing. Check the container itself for a file only the current code has:
  `sudo docker exec adc-video-bridge ls dist/utils/table.js`.
  ⚠️ This NAS has **Compose v1**: `docker-compose` (hyphen), and `docker compose` does not exist.
- ✅ **Infrastructure healthy**: two containers, go2rtc bound to
  **`192.168.7.42` only** (not `0.0.0.0`), `401` unauthenticated / `200` authenticated, HomeKit
  accessory **paired with `pairings` persisted to disk**, SRTP listening on UDP 8443, motion endpoint
  verified end to end (`POST` sets, `DELETE` clears).
- 🔑 **THE STATUS ENDPOINT IS THE FIRST THING TO CHECK — no sudo needed.**
  ```
  curl -s --user "$STATUS_USERNAME:$STATUS_PASSWORD" http://192.168.7.42:9090/ | jq
  ```
  (credentials are in `.env` on the NAS). Returns per-camera state, both circuit states, consecutive
  failures, next-probe time, and the last error with its age. This replaces the `docker-compose logs`
  round-trip that cost three sudo prompts in one session.
- 🔴 **THE ONLY BLOCKER: Alarm.com now issues NO end-to-end WebRTC config for this camera**
  (`endToEndWebrtcConnectionInfo: null`, `errorEnum: 0`, login fine, proxy config still populated —
  confirmed twice an hour apart via `probe.js`). Still not ours, but ⚠️ **no longer the same symptom
  as 2026-08-04.** In the one 2026-08-06 window where a config *was* issued, the camera **dialed in,
  completed `SESSION_STARTED`, and sent no video** — a strictly later failure than "never dials in".
  📖 **Evidence, the three measured states, and the deduction: `Journal.md` 2026-08-06.** Do not
  re-derive it from the endpoint; two of the three states report an all-clear.
  Per [`INVARIANTS.md`](INVARIANTS.md), that null means *"Direct has been failing for this camera"*
  and clears when connectivity is fixed. 🔴 **Do NOT build the Janus proxy path in response.**
  ➡️ **A Brinks/Alarm.com support call, not a code change.** Wording to use:
  *"Alarm.com returns `endToEndWebrtcConnectionInfo: null` for this camera — no end-to-end WebRTC
  configuration at all — while proxy config is still populated. Earlier the same field was populated,
  and in the one window where a session did establish, the camera completed signaling and delivered
  no video. The Brinks app still streams it over proxy."*
  ⚠️ Do not re-diagnose from our logs — [`INVARIANTS.md`](INVARIANTS.md) records the three theories
  already raised and retracted, and its `endToEndWebrtcConnectionInfo: null` entry covers this exactly.
- ⚠️ **`patches/go2rtc-hap-auth-exempt.patch` is load-bearing.** Without it HomeKit cannot pair at
  all while go2rtc API auth is on. Applied with plain `git apply` in `Dockerfile.go2rtc`, so a patch
  that stops applying **fails the build loudly**. 🔴 Report upstream on
  [go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) and delete it when it lands there.
- **Sudo-free diagnosis on Kaikoura:** the status endpoint above; then `/usr/local/bin/node
  dist/probe.js <cameraId>` from `/volume1/docker/adc-video-bridge` after `set -a; . ./.env; set +a`.
  🔎 **Before reading any of it, see [`INVARIANTS.md`](INVARIANTS.md) → "Reading the status endpoint"
  and "`node` … is NOT on a non-interactive ssh PATH".** Three status fields and three host quirks
  each cost time on 2026-08-06; all six are recorded there rather than repeated here.
- **⬆️ Eight upstream PRs and two issues open at Omar-L**, all awaiting his review. Nothing blocked on
  us. See [`UPSTREAM.md`](UPSTREAM.md).
- **Whose turn:** **David** — call Brinks/Alarm.com, using the 2026-08-06 wording in the blocker
  above, not the older "never dials in". Every layer we control is built, deployed and verified;
  video appears on its own once Alarm.com issues an e2e config again, with **no redeploy needed**.

### What's left (priority order)

1. 🔴 **(David — SUPPORT CALL, gates everything)** Alarm.com issues no end-to-end WebRTC config for
   this camera (`endToEndWebrtcConnectionInfo: null`), and in the one 2026-08-06 window where it did,
   the session established and **no media followed**. Proxy still works (the app streams). Nothing in
   our code can fix it and everything else is blocked behind it. Full evidence in the blocker above.
2. 🔴 *(Agent — BLOCKED on video; both need a real camera to pick a timeout)* **Two observability
   defects, found 2026-08-06. Both let a dead stream look calm:**
   - **No media watchdog after `SESSION_STARTED`** — a trackless session is recorded as a *success*
     (`breaker.recordSuccess()`), resetting the breaker that should catch it, and `state` sits at
     `'connecting'` forever. Fix shape: fail the attempt if no track arrives within N seconds.
   - **A camera never attempted reports `idle` with zero errors** for ~30 min, until the token
     breaker opens (`VIDEO_TOKEN_FAILURE_THRESHOLD = 3` × `VIDEO_TOKEN_REFRESH_MS = 600s`).
   🔑 Both are the trap `README.md` documents one layer up — *"did not produce a usable result"* is
   the failure, not *"threw"* — never applied downward. 📖 Reasoning: `Journal.md` 2026-08-06.
3. *(Agent — do this when video returns)* **Verify HKSV actually records without transcoding:**
   `[hksv] flush fragment` lines with sequential `seq` and ~67 KB fragments, an `hksv` consumer
   alongside `homekit` from one producer, and **no ffmpeg beyond the bridge's one**. Compare against
   the spike's 0.7% CPU / ~22 MB.
4. *(David — after 3 verifies)* **Remove the Homebridge camera accessory** and its config. Until
   then both accessories exist deliberately — that is the documented cutover.
5. **(David — 1 min)** `/volume1/homebridge/config.json` is **775**; world-read remains, and
   `INVARIANTS.md` sets 600 as the standard. ⚠️ Re-check after any Homebridge settings change: the
   volume's default ACL is 0777 and the UI rewrites the file.
6. *(Agent, low)* **A/B `-reorder_queue_size 0`** — production logs show repeated
   `Non-monotonic DTS ...`. Test only once video is stable, or it measures the link.
7. *(Agent, low)* go2rtc stream auto-configuration; `src/discover.ts` already generates both blocks.
8. *(Agent, low)* Audio passthrough. ⚠️ A camera on Proxy has no audio at all.
9. *(Agent — BLOCKED on video, do not fix blind)* `onFailed` fires on `'disconnected'` as well as
   `'failed'` ([`peer-session.ts:235`](../src/camera/peer-session.ts)), so a transient ICE blip
   forces a full teardown. `'disconnected'` is the recoverable state in WebRTC and `'failed'` the
   terminal one, so the shape of the fix (debounce, and act only if it has not recovered) is not in
   doubt — but the timeout is a *tuning* value, and choosing it without a real camera would be
   guessing. ⚠️ Deliberately not attempted 2026-08-05.
   ✅ The other four deferred review nits are **DONE** (2026-08-05): dead `'fallback'` member of
   `OverlapOutcome` removed; the false "activeDied cannot be true here" comment in `reconnect()`
   corrected; `rtpCount` now reset in `cutOver()`; `tryConnect()` sets `_state = 'error'` on
   rejection instead of stranding it at `'connecting'`.
10. ✅ **DONE (2026-08-05)** — `src/discover.ts` printed `%-20s` literally (`util.format` has no
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
