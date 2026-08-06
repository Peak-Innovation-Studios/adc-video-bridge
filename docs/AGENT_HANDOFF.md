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
- **Updated:** 2026-08-04 — **Phases 0, 1 and 2 all landed.** The two-container split is deployed,
  native HKSV is configured and paired, motion is wired. **There is still no video: the camera never
  dials in.** Narrative: `Journal.md`, entries "Phases 1 & 2" and "Phase 2".
- **Branch / HEAD:** `git fetch && git status -sb && git log --oneline -1`. `main` deploys by hand.
  💡 "Do I need a rebuild?" is answerable from git: the Dockerfile copies only `package*.json`,
  `tsconfig.json`, `src/`, `patches/` and `entrypoint.sh`.
- **Working tree:** `git status --short` **and `git stash list`**. Both empty at handoff.
- **Validation (re-run before trusting):** `npm run build` clean, `npx vitest run`
  **16 files / 236 tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp
  exception.
- ✅ **DEPLOYED AND HEALTHY on Kaikoura** (`656baed`): two containers, go2rtc bound to
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
- 🔴 **THE ONLY BLOCKER: the camera never dials in — and it is almost certainly NOT ours.**
  Measured on a **fresh process with a clean circuit and zero backoff**: `idle → error → idle`, with
  `Camera <id> has not yet dialed in` from Alarm.com's own signaling server, while the **Brinks app
  streams the camera fine**. Alarm.com's **own web player also failed** earlier. Reading: end-to-end
  WebRTC is unavailable for every client while proxy streaming works.
  ➡️ **This is a Brinks/Alarm.com support call, not a code change.** Wording that gets past
  first-line: *"the camera streams in the app but never dials in to the end-to-end WebRTC signaling
  server."* ⚠️ Do not re-diagnose this from our logs — see [`INVARIANTS.md`](INVARIANTS.md), which
  records the three theories already raised and retracted.
- ⚠️ **`patches/go2rtc-hap-auth-exempt.patch` is load-bearing.** Without it HomeKit cannot pair at
  all while go2rtc API auth is on. Applied with plain `git apply` in `Dockerfile.go2rtc`, so a patch
  that stops applying **fails the build loudly**. 🔴 Report upstream on
  [go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) and delete it when it lands there.
- **Sudo-free diagnosis on Kaikoura:** the status endpoint above; `node dist/probe.js <cameraId>` and
  `node dist/discover.js` after `set -a; . ./.env; set +a`. ⚠️ `probe.js` reads Alarm.com's
  **database** and proves nothing about whether the camera can stream.
- **⬆️ Eight upstream PRs and two issues open at Omar-L**, all awaiting his review. Nothing blocked on
  us. See [`UPSTREAM.md`](UPSTREAM.md).
- **Whose turn:** **David** — call Brinks/Alarm.com. Every layer we control is built, deployed and
  verified; video appears on its own once the camera dials in, with **no redeploy needed**.

### What's left (priority order)

1. 🔴 **(David — SUPPORT CALL, gates everything)** The camera never dials in for end-to-end WebRTC.
   Proxy works (app streams), e2e does not (our bridge *and* Alarm.com's own web player fail).
   Nothing in our code can fix it and everything else is blocked behind it.
2. *(Agent — do this when video returns)* **Verify HKSV actually records without transcoding:**
   `[hksv] flush fragment` lines with sequential `seq` and ~67 KB fragments, an `hksv` consumer
   alongside `homekit` from one producer, and **no ffmpeg beyond the bridge's one**. Compare against
   the spike's 0.7% CPU / ~22 MB.
3. *(David — after 2 verifies)* **Remove the Homebridge camera accessory** and its config. Until
   then both accessories exist deliberately — that is the documented cutover.
4. **(David — 1 min)** `/volume1/homebridge/config.json` is **775**; world-read remains, and
   `INVARIANTS.md` sets 600 as the standard. ⚠️ Re-check after any Homebridge settings change: the
   volume's default ACL is 0777 and the UI rewrites the file.
5. *(Agent, low)* **A/B `-reorder_queue_size 0`** — production logs show repeated
   `Non-monotonic DTS ...`. Test only once video is stable, or it measures the link.
6. *(Agent, low)* go2rtc stream auto-configuration; `src/discover.ts` already generates both blocks.
7. *(Agent, low)* Audio passthrough. ⚠️ A camera on Proxy has no audio at all.
8. *(Agent — BLOCKED on video, do not fix blind)* `onFailed` fires on `'disconnected'` as well as
   `'failed'` ([`peer-session.ts:235`](../src/camera/peer-session.ts)), so a transient ICE blip
   forces a full teardown. `'disconnected'` is the recoverable state in WebRTC and `'failed'` the
   terminal one, so the shape of the fix (debounce, and act only if it has not recovered) is not in
   doubt — but the timeout is a *tuning* value, and choosing it without a real camera would be
   guessing. ⚠️ Deliberately not attempted 2026-08-05.
   ✅ The other four deferred review nits are **DONE** (2026-08-05): dead `'fallback'` member of
   `OverlapOutcome` removed; the false "activeDied cannot be true here" comment in `reconnect()`
   corrected; `rtpCount` now reset in `cutOver()`; `tryConnect()` sets `_state = 'error'` on
   rejection instead of stranding it at `'connecting'`.
9. ✅ **DONE (2026-08-05)** — `src/discover.ts` printed `%-20s` literally (`util.format` has no
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
