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
- **Updated:** 2026-08-08 — **merged `docs/community-onboarding` into `main`** (fast-forward, 12
  commits). Reviewed and re-validated first; no code was written this session. The architecture
  state below is unchanged from 2026-08-07: all three cameras live in HomeKit over their **own
  local RTSP**, go2rtc's native client, in-process HKSV, **zero ffmpeg in the media path**. Both
  ADC-V515s work. HKSV **recording is proven**. Motion is detected by go2rtc itself, so
  **Alarm.com is out of the video path entirely**. 📖 `Journal.md` 2026-08-07 (evening/night/late).
- 🔴 **Do NOT write push state here. Run the command:** `git fetch && git log --oneline origin/main..main`
  ⚠️ **Twice in two days this line has been wrong in this repo, in both directions.** The 08-07 baton
  said the branch was "pushed" when `origin/docs/community-onboarding` had stopped at `65fca25`; the
  08-08 baton said `main` was "12 commits ahead and NOT pushed" and was overtaken by a real push
  ~90 seconds after it was committed. A count is stale the moment anything happens; the command
  never is. 🔑 Verify with `git ls-remote origin refs/heads/main`, not a local `origin/*` ref —
  those are only as fresh as the last fetch.
  📌 What git cannot tell you, so it belongs here: **`origin/docs/community-onboarding` is
  abandoned at `65fca25`.** `main` contains everything that branch had; the stale ref is not a
  missing push and needs no reconciling. Delete it when convenient.
- 🔑 **The merge does NOT require a rebuild or a deploy, and the reason is narrower than "docs
  only".** It adds `src/mobile/`, `src/discover-local-cli.ts` and a `package.json` *script* (no
  dependency change, lockfile untouched). `COPY src/ src/` matches by prefix, so a rebuild WOULD
  produce a different image — but **nothing `index.ts` imports transitively changed** (verified by
  grep, not assumed), and both new entry points are hand-run CLIs. The deployed image stays correct.
- **Branch / HEAD:** `git fetch && git status --short && git log --oneline -1`.
  ⚠️ Pushing does NOT deploy. The NAS checkout at `/volume1/docker/adc-video-bridge` is a separate
  clone, pulled and rebuilt BY HAND, and every `docker-compose` command needs David's sudo — an
  agent cannot deploy. ⚠️ **Compose is v2.20.1** despite the hyphenated binary name.
  💡 "Do I need a rebuild?" — derive it from the `COPY` lines, not a summary. The bridge image takes
  `package.json`, `package-lock.json`, `tsconfig.json`, `src/`, `entrypoint.sh`. Match by PREFIX
  (`^src/`), never `^src/$`.
- **Deployed:** `main` @ `37d1236`, image rebuilt, `/pair` and `events` both live and verified.
  ⚠️ **The NAS is DELIBERATELY behind `main`** — see the rebuild note above. What it is behind by is
  a count; get it from `git log --oneline 37d1236..main`. It is a documentation/CLI gap, not drift;
  do not "fix" it with a rebuild nobody asked for.
- **Validation:** run **2026-08-08 against `5192eaf`** (the merge commit — later baton-only commits
  do not affect it), all three green:
  `npm run build` clean, `npx vitest run` **23 files / 358 tests**, `npm run audit:prod` passes with
  the documented GHSA-2p57-rm9w-gvfp exception. ⚠️ Re-run before trusting — these were measured
  before any later change.
  🔑 The relay's structural guards were **mutation-checked**. ⚠️ Calibration: the base64 bug passed
  **8 of 12** tests including the whole handshake. A passing handshake test proves nothing here.
- 🔑 **THREE SUDO-FREE TOOLS, in the order you will want them:**
  ```
  ssh kaikoura 'cd /volume1/docker/adc-video-bridge && export PATH=/usr/local/bin:$PATH && \
    npm run verify:config --silent -- .'                       # config seams; 0 blocking today
  ssh kaikoura 'cd /volume1/docker/adc-video-bridge && set -a && . ./.env && set +a && \
    curl -s --user "$STATUS_USERNAME:$STATUS_PASSWORD" http://192.168.7.42:9090/'   # relays+events
  curl .../9090/pair                                            # scannable HomeKit setup codes
  ```
  🔑 **The NAS carries full devDependencies — every `tsx` CLI runs THERE.** ⚠️ `npm` and `node` are
  NOT on a non-interactive ssh PATH; export `/usr/local/bin` or you get "command not found".
  ⚠️ No `jq` on the NAS — pipe output back to the Mac.
- 🔴 **TRIAGE: port 9090 REFUSING means the BRIDGE is down — stop looking at relay ports.** A config
  error and an unpublished port are indistinguishable from a client. ⚠️ The bridge can crash-loop
  **after** logging three healthy relay lines and a successful login.
- 🔑 **`events.messagesReceived` answers "is motion working?"** — it separates "Alarm.com sends
  nothing" from "events arrive but none are motion". ⚠️ `events.connected: true` is NOT evidence
  that events flow.
- 🔴 **A HomeKit pairing that is not in `config/go2rtc.yaml` exists in MEMORY ONLY and dies on
  restart.** One duplicate YAML key anywhere in that file disables **every** config write go2rtc
  makes. That is what an accessory stuck on **"Connecting…"** means.
  ([`INVARIANTS.md`](INVARIANTS.md))
- 🔴 **NEVER commit** credentials, MACs, LAN/WAN IPs, tokens, camera **names** or IDs.
  ⚠️ **A leak check that reports without BLOCKING is not a check** — a fixture carrying the real
  camera username was committed this session while the scan printed the finding and the commit
  proceeded anyway. Both that and earlier camera names remain in history.
- 🔴 **`log: { homekit: trace }` is still enabled in `config/go2rtc.yaml`** and marked TEMPORARY.
  Remove it and restart go2rtc once the motion thresholds are settled.
- **Whose turn:** **DAVID.** Nothing is broken. ✅ The merge is DONE and pushed. In order:
  **(1)** count real triggers over a night — `sudo docker-compose logs go2rtc | grep -c "motion: ON"`
  — then cross-check any hits against the Home app timeline; that settles the thresholds (item 2).
  ⚠️ `grep "motion:" | tail -N` shows only the noise floor and hides triggers — it is why none have
  been counted yet. **(2)** ONE `discover:local` from a cold start (item 3).

### What's left (priority order)

1. ✅ **DONE — local RTSP is ADOPTED and deployed.** All three cameras live in HomeKit via
   `src/rtsp/tunnel-relay.ts`, go2rtc's native client, in-process HKSV, no ffmpeg. Both V515s work.
   Runbook: [`SETUP.md`](SETUP.md) → "Step 2b". Design + traps: [`INVARIANTS.md`](INVARIANTS.md).
   ⚠️ What it still does NOT do: fetch its own endpoints (item 3), and prove HKSV *records* (item 2).

2. ⚠️ **Motion works; thresholds are MEASURED but not yet confirmed over a full night.**
   ✅ HKSV recording is proven and all three cameras use `motion: detect`, so Alarm.com is out
   of the loop. Current values: front 4.5, kitchen 5.5, sunroom 3.5.
   🔑 **Measured 2026-08-07 via `log: { homekit: trace }`:** `ratio` sat at **0.68-1.22** across all
   three, against baselines of ~1720 / ~1200 / ~700 — read at the time as 3-4.5× headroom.
   🔴 **NOT REPRODUCED. Second sample 2026-08-08 16:05-16:09 (40 lines, 3 streams) gives
   0.62-2.89** — 16 of 40 samples outside the old range, three above 2.0. By baseline cluster:
   HIGH 1728-4467 → max **2.89**; MID 790-1084 → max 1.79; LOW 179-250 → max **2.26**.
   ⚠️ **Neither window's occupancy was verified, so NEITHER is an idle measurement** and the
   "3-4.5× headroom" figure inherits that. 16:05 on a Saturday is not idle; these highs may be real
   motion. **Do not "correct" the thresholds from either sample.** (This is the same trap already
   paid for once: an earlier "false positives" reading was wrong for exactly this reason.)
   ⚠️ `motion: status` samples 1 frame in 150 — it shows the noise FLOOR, never the spikes that
   trigger, so 2.89 is a LOWER BOUND on the peak, not the peak. Only a `motion: ON` line carries a
   trigger's ratio. ⚠️ 13-14 samples per camera cannot bound a tail, and the tail is what fires.
   🔴 **The log line carries NO stream name** — the three thresholds (front 4.5, kitchen 5.5,
   sunroom 3.5) have no *measured* mapping to the three baselines. Rank-order matching against the
   2026-08-07 figures is a guess, and weak: the low baseline moved ~700 → ~200 between samples.
   ➡️ **Next, in this order.** (a) `sudo docker-compose logs go2rtc | grep -c "motion: ON"` over a
   window covering a night — ⚠️ a `grep "motion:" | tail -40` shows only the floor and hides
   triggers, which is why none have been counted yet. (b) Cross-check any hits against the Home app
   timeline. Clips at 3am = false positives, raise. No clips = these values are right, and could
   even come down for sensitivity.
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
