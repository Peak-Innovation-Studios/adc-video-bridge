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
- **Updated:** 2026-08-06 (later) — **SETTLED: the outage is account-wide on Alarm.com's side.** Not
  the camera, not our code — 3 of 3 cameras return a null e2e block, including two connected that day
  that our bridge has never contacted. Brinks are scheduling a virtual technician session.
  Narrative: `Journal.md` 2026-08-06 (later).
- **Branch / HEAD:** `git fetch && git status -sb && git log --oneline -1`. `main` deploys by hand.
  💡 "Do I need a rebuild?" is answerable from git — but **derive it from the `COPY` lines, not from
  this summary.** As of 2026-08-06 the bridge image takes `package.json`, `package-lock.json`,
  `tsconfig.json`, `src/` and `entrypoint.sh`; the go2rtc image takes `patches/` plus a pinned
  upstream commit. That is an explicit file list, not a glob, so a paraphrase here drifts silently.
- **Working tree:** `git status --short` **and `git stash list`**. Both empty at handoff — and the
  NAS checkout at `/volume1/docker/adc-video-bridge` is a *separate* clone that is also pulled to
  `main`; changing files there is not the same as changing them here.
- **Validation (re-run before trusting):** `npm run build` clean, `npx vitest run`
  **16 files / 237 tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp
  exception.
- ✅ **Bridge RUNNING again (2026-08-06)** — it was stopped for ~55 min for the cold probe below, and
  has been restarted. Expected healthy-but-blocked reading right now: `state: idle`, both circuits
  starting closed, `tokenFailures` climbing to 3 over ~20 min and then `tokenCircuit: open`. That is
  the breaker working, not a new fault. ⚠️ A stopped bridge and a broken camera look identical from
  outside — the endpoint is simply unreachable either way — so confirm it is up before diagnosing:
  `curl -s -o /dev/null -w '%{http_code}' http://192.168.7.42:9090/` → `401` means running.
- ✅ **DEPLOYED on Kaikoura and VERIFIED CURRENT (2026-08-06)** — rebuilt after the status-endpoint
  field rename, confirmed by the live endpoint emitting the six per-breaker field names.
  ⚠️ `src/` has since changed by **comments only** (`0247afe`), so a strict "did a COPY path change?"
  check says rebuild; it is a no-op and no rebuild is warranted.
  ⚠️ Do not trust a remembered commit: the host `dist/` is stale by design (the Dockerfile builds
  *inside* the image), so it proves nothing. Check the container itself for a file only current
  code has:
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
  (credentials are in `.env` on the NAS). Returns per-camera state, and for **each** breaker its own
  circuit state, failure count and cooldown (`streamCircuit`/`streamFailures`/`streamNextProbeInMs`,
  `tokenCircuit`/`tokenFailures`/`tokenNextProbeInMs`), plus the last error with its age. This
  replaces the `docker-compose logs` round-trip that cost three sudo prompts in one session.
- 🔴 **THE ONLY BLOCKER — SETTLED: Alarm.com provisions NO end-to-end WebRTC for this ACCOUNT.**
  Not the camera, not our code, and 🔴 **not worth re-investigating.** Measured 2026-08-06, one
  login, one videoSource call per camera:

  | name | model | e2e | proxy | errorEnum |
  |---|---|---|---|---|
  | Front | ADC-V723 | **null** | set | 0 |
  | Kitchen | ADC-V515 | **null** | set | 0 |
  | Sunroom | ADC-V515 | **null** | set | 0 |

  **3 of 3, two models — and Kitchen/Sunroom were connected that day, which our bridge has never
  contacted** (it is configured for one camera). `errorEnum: 0` beside a null block means their
  service reports success while omitting the configuration — that pairing is the quotable line for
  the technician session.

  🔑 **THE ARTIFACT TO READ OUT — captured from ALARM.COM'S OWN WEB PLAYER, 2026-08-06.** Logged in
  to their website, clicking a camera, their client calls the **same endpoint we do** and gets the
  **same answer**:

  > `GET /web/api/video/videoSources/liveVideoHighestResSources/<id>` → `HTTP 200`, `errorEnum: 0`,
  > `includedTypes: ["proxyWebrtcConnectionInfo"]`, `endToEndWebrtcConnectionInfo: null`.
  > It then plays over the Janus proxy and **times out after 3 minutes** with their own message:
  > *"The stream has timed out. Please press play to continue playback."* — matching
  > `proxyStreamTimeoutTime: 180`. Our integration makes the identical request and receives the
  > identical response.

  ➡️ **This is positive evidence, not a failure report** — it cannot be blamed on our code, the
  network, or a browser setting, because their own client succeeds and still gets a null field.
  It also settles the last open question: **we are NOT being treated differently from their browser.**
  ⚠️ Supersedes the earlier "their web player fails too" claim, which was Safari's iCloud Private
  Relay and was rightly retracted — see [`INVARIANTS.md`](INVARIANTS.md) → "No video" diagnosis order.
  📖 **Everything else is in `Journal.md` 2026-08-06 and 2026-08-06 (later)**: the three earlier
  states, the two experiments that ruled our code out (do not re-run them), and how the app still
  streams via Alarm.com's Janus relay on their 3-minute no-audio fallback — so the cameras are
  ONLINE and reaching Alarm.com; only Direct is unprovisioned.
  🔴 **Do NOT build the Janus proxy path in response** — [`INVARIANTS.md`](INVARIANTS.md); tracked
  upstream as Omar-L#2. ⚠️ Its janus fields are in the payload **always**; the signal is the pair,
  proxy SET **and** e2e null.
  ✅ **Network path ELIMINATED (2026-08-06)** — but not by the argument first recorded here. The
  app-vs-website disagreement turned out to be Private Relay, so that reasoning is void. The
  elimination that holds is simpler and does not depend on any other client: **the bridge receives a
  valid, authenticated HTTP 200 with `errorEnum: 0` and one field omitted.** A network fault does not
  produce a well-formed JSON response missing exactly one key. Also measured: the NAS and David's Mac
  egress from the **same public IP** (via the LAN gateway; Tailscale installed but
  not carrying traffic), so the bridge is not on a masked or relayed path either.
- ⚠️ **`patches/go2rtc-hap-auth-exempt.patch` is load-bearing.** Without it HomeKit cannot pair at
  all while go2rtc API auth is on. Applied with plain `git apply` in `Dockerfile.go2rtc`, so a patch
  that stops applying **fails the build loudly**. 🔴 Report upstream on
  [go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) and delete it when it lands there.
- **Sudo-free diagnosis on Kaikoura:** the status endpoint above; then `/usr/local/bin/node
  dist/probe.js <cameraId>` from `/volume1/docker/adc-video-bridge` after `set -a; . ./.env; set +a`.
  🔎 **Before reading any of it, see [`INVARIANTS.md`](INVARIANTS.md) → "Reading the status endpoint"
  and "`node` … is NOT on a non-interactive ssh PATH".** Three status fields and three host quirks
  each cost time on 2026-08-06; all six are recorded there rather than repeated here.
- **⬆️ Omar-L is merging: #26 and #29 landed 2026-08-06, six PRs still open.** Nothing blocked on us.
  🔴 **Do NOT "sync fork" as they land** — it conflicts in 3 files and gains no content (our `main` is
  effectively a superset). Wait until all six merge, then reconcile once. Full reasoning and the
  dry-run result: [`UPSTREAM.md`](UPSTREAM.md).
- **Whose turn:** **BRINKS.** The support call happened 2026-08-06 and they are scheduling a
  **virtual technician session**. Nothing is on us and nothing is on David until that session — take
  the 3-of-3 table above to it, plus `errorEnum: 0` beside a null e2e block, which says their service
  reports success while omitting the configuration. Every layer we control is built, deployed and
  verified; video appears on its own once Alarm.com provisions Direct again, **no redeploy needed**.

### What's left (priority order)

1. 🔴 **(BRINKS — virtual technician session being scheduled; gates everything)** Alarm.com issues no
   end-to-end WebRTC config for **any** camera on the account (3 of 3, two models, two of them added
   2026-08-06 and never touched by our code). Proxy still works, so the cameras are online. Nothing
   in our code can fix it, nothing further is worth measuring from our side, and everything else is
   blocked behind it. Full evidence in the blocker above.
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
