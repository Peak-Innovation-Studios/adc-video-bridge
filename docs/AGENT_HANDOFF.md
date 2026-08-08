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
- ✅ **`log: { homekit: trace }` REMOVED 2026-08-08 (David).** `config/go2rtc.yaml` now has just
  `log:` → `level: info`, verified well-formed.
  ⚠️ **Consequence: there is now NO motion visibility at all.** `motion: ON` is a **DBG** line, so
  at `info` no trigger is ever logged — the only remaining feedback is clips appearing in the Home
  app, which is slower and coarser. 🔑 If tuning thresholds again, set `log: { homekit: debug }`
  (not `trace`): DBG keeps `motion: ON` and drops the 1-in-150 `motion: status` flood.
- 🔑 **go2rtc logs in UTC; local is UTC-5. 3am local = `08Z`.** Its inline clock equals Docker's
  `-t` stamp exactly. A `16:05` line is 11:05 local — already mis-read once as "afternoon".
- **Whose turn:** **AGENT.** Nothing is broken and **no blocker remains.** ✅ merge done and
  pushed; ✅ item 2 settled; ✅ **item 3 DONE — live sign-in succeeded 2026-08-08 13:04 and the
  output matched production exactly.** The project is now adoptable by someone who has only an
  Alarm.com username and password.
  **(1)** Item 15 — the positional `listenPort` collision, a real latent bug.
  **(2)** Push `agent/discover-local-write` (3 commits) and merge it.
  **(3)** DAVID, whenever: `MOBILE_API.md`'s remaining "still to do" — refresh endpoints at
  runtime so a camera that changes address self-heals rather than needing setup re-run.

### What's left (priority order)

1. ✅ **DONE — local RTSP is ADOPTED and deployed.** All three cameras live in HomeKit via
   `src/rtsp/tunnel-relay.ts`, go2rtc's native client, in-process HKSV, no ffmpeg. Both V515s work.
   Runbook: [`SETUP.md`](SETUP.md) → "Step 2b". Design + traps: [`INVARIANTS.md`](INVARIANTS.md).
   ⚠️ What it still does NOT do: fetch its own endpoints (item 3), and prove HKSV *records* (item 2).

2. ✅ **SETTLED 2026-08-08 — no false positives overnight.** HKSV recording is proven and all three
   use `motion: detect`, so Alarm.com is out of the loop.
   ✅ **THRESHOLDS NOW front 4.0 · kitchen 4.0 · sunroom 3.5** (was 4.5 / 5.5 / 3.5). Edited
   2026-08-08 11:43, go2rtc restarted by David. Verified after the restart: file still reads 4.0,
   **mtime unchanged at 11:43:28 so go2rtc did NOT rewrite it**, all 12 pairing entries intact,
   `verify:config` 0 blocking, all three relays `connections: 1` with `bytesDown` climbing.
   Backup, outside the repo and the build context, mode 600: `~/go2rtc.yaml.bak-20260808-113942`.
   ✅ **CONFIRMED LIVE, not inferred.** go2rtc's startup banner reads `2026-08-08T17:44:41Z`
   (12:44:41 local) against an edit at 11:43:28 local (`16:43:28Z`) — the restart came **1h 1m
   after** the edit, so the running process loaded 4.0. `revision=506cfa7.dirty` unchanged, i.e. a
   restart and not a rebuild, exactly as a config-only change should be.
   🔑 **How to re-verify, and why this command and not another:** an unmodified config file is
   equally consistent with "restarted and read it" and "never restarted" — a state carries no time.
   The banner is an EVENT, so it timestamps itself:
   `sudo docker-compose logs -t go2rtc | grep "go2rtc platform" | tail -1`. `restart` reuses the
   container so logs accumulate; `tail -1` is the CURRENT process. ⚠️ Compare against the config's
   mtime in the SAME zone — go2rtc logs UTC, local is UTC-5.
   ⚠️ Whenever this file is edited again: **do not pair/unpair between edit and restart** — go2rtc
   persists its own config, so a write from memory silently reverts the edit.
   🔑 **Why 4.0:** both 4.5 and 5.5 sat ABOVE the weakest real trigger observed (4.46), so they
   risked missing real motion; 4.0 is inside the measured 2.89-4.46 gap. Sunroom left at 3.5 — it is
   the only threshold with direct evidence behind it. ⚠️ That 4.46 trigger MUST have been sunroom
   (only camera then below 4.46), so front's and kitchen's real-motion ratios are **unmeasured** and
   4.0 assumes their scenes behave like sunroom's. Accepted because the error directions are not
   symmetric: **false positives show up as clips; missed motion is silent.** Revert to 4.5/5.5 if
   clips appear at 3am.
   🔴 **go2rtc logs in UTC; local is UTC-5.** Its inline clock is byte-identical to Docker's `-t`
   stamp (`22:41:20.710` == `22:41:20.710Z`). **3am local = `08Z`.** An earlier reading in this repo
   mis-called a `16:05` line "afternoon"; it was 11:05 local. Convert before concluding anything.
   🔑 **The measurement.** `motion: ON` counts per hour over the night of 08-07→08:
   `23:00` 2 · `00:00` 1 · **`01:00`-`05:00` ZERO** · `06:00` 1 · `07:00` 15 · `08:00`-`11:00` 25.
   ✅ **The zero is BRACKETED** by events at 00:00 and 06:00, so the detector and log path were
   demonstrably live straight through it — that is what makes it a measurement and not an
   instrument gap. The 07:00 spike of 15 has the shape of a household waking up; a false-positive
   process has no reason to respect that.
   🔑 **Clean separation, and the thresholds sit in the gap:** noise floor (`motion: status`) tops
   out at **2.89**; real triggers (`motion: ON`) run **4.46-12.51**; nothing observed between.
   ⚠️ **ONE night, not three.** `motion: ON` is a **DBG** line and the earliest is `08-08T04Z`, so
   debug logging only began ~12h before the sample. The log's 65.6h span is NOT the measurement
   window — silence on 08-05→07 is a logging artifact, not evidence.
   ⚠️ **The risk has FLIPPED to under-sensitivity.** Kitchen's 5.5 is above the weakest real trigger
   seen (4.46). Five sampled ratios is too few to act on — watch, do not change blind.
   🔑 **Neither line type carries a stream name, but ratio bounds partially attribute:** a trigger
   fires only above its own threshold, so any `ON` below 4.5 **must** be sunroom (3.5), and only
   one above 5.5 can be kitchen. That is the only attribution available.
   ⚠️ `motion: status` samples 1 frame in 150 — it is the noise FLOOR, never the spikes that
   trigger, so 2.89 is a LOWER BOUND. Only `motion: ON` carries a real trigger's ratio; a
   `grep "motion:" | tail -N` shows only the floor and hides triggers.
   ➡️ **Next (agent, small): drop `log: { homekit: trace }` to `debug` rather than removing it.**
   `motion: ON` is DBG and `motion: status` is TRC, so `debug` keeps the one useful line and drops
   the 1-in-150 flood. Removing the key entirely also removes the only trigger visibility there is.
   ➡️ **Next, in this order.** (a) `sudo docker-compose logs go2rtc | grep -c "motion: ON"` over a
   window covering a night — ⚠️ a `grep "motion:" | tail -40` shows only the floor and hides
   triggers, which is why none have been counted yet. (b) Cross-check any hits against the Home app
   timeline. Clips at 3am = false positives, raise. No clips = these values are right, and could
   even come down for sensitivity.
   🔴 **`log: { homekit: trace }` is TEMPORARY and still enabled** — remove it and restart
   go2rtc once the thresholds are settled.

3. ✅ **DONE 2026-08-08 13:04 — THE COMMUNITY BLOCKER IS GONE. Live sign-in SUCCEEDED.**
   `npm run discover:local` authenticated against `mobile.alarm.com` and returned all 3 cameras
   with their local RTSP endpoints.
   ⚠️ **Do NOT describe this as "onboarding is now just username and password" — it is not, and
   an earlier draft of this line said so wrongly.** A new user must STILL proxy the app once, to
   capture four device values (`Haiku`, `MobileDeviceUid`, `HashCode`, `TwoFactorId`). What
   changed is WHAT they extract: **four fixed values instead of per-camera endpoints and
   credentials** — and the tool then enumerates any number of cameras and re-reads them whenever
   they change. The TLS-intercepting-proxy step is reduced, not removed.
   ❓ **Untested and worth knowing:** whether `Haiku` is per-install or a client constant, and
   whether a freshly generated `MobileDeviceUid` works in place of a captured one. Both were
   among the variables permuted during the contaminated run, so nothing reliable is known. If
   `Haiku` turns out to be a constant, the proxy step disappears entirely — that is the single
   highest-value unknown left on this API. 🔴 Answer it by OFFLINE comparison or a single
   deliberate attempt, never by permuting.
   🔑 **PROVEN CORRECT, not merely non-empty.** Every generated field matched the running
   production config — which was hand-extracted from a capture weeks earlier and is therefore an
   INDEPENDENT artifact: all three camera ids, hosts, ports and RTSP credentials identical. That
   exercises the whole chain — auth, gunzip, `<lnr>` parse, `lre` extraction, and the
   `UnitId`+`did` → web-API-id reconstruction. A parser reading the wrong attribute would have
   returned plausible data and failed this.
   ⚠️ **What the match does NOT prove:** `listenPort` is assigned by the CLI positionally
   (`8561 + index`), never read from the API. It matched only because Alarm.com happened to
   return the cameras in the same order as the existing config. **See item 15 — that is a latent
   bug, not a validated behaviour.**
   ⚠️ Do not paste the generated `pin:` values into a PAIRED install (item 2's cameras are all
   paired; new pins break pairing and lose HKSV history), and do not take the generated
   `motion_threshold: 3.5` for front/kitchen — those are 4.0 by measurement.

   *(historical, kept because the diagnosis is the reusable part)* **(THE community blocker)** A
   `mobile.alarm.com` client so endpoints and per-camera credentials are fetched rather than
   typed in by hand. 📄 **Full detail: [`MOBILE_API.md`](MOBILE_API.md).**
   ✅ **Captured and implemented 2026-08-07:** `POST /MobileServlet/SubmitRequest.aspx`,
   `Action=UberLoginNew`, password in PLAINTEXT, and the response `<lnr>` **contains the
   cameras** — `<cli>` elements carry `lre` (local RTSP), `l`/`p` credentials, and
   `UnitId`+`did` which reconstruct the web API's camera id. No second call needed.
   Built: `src/mobile/mobile-api.ts` + `npm run discover:local`, which prints paste-ready
   blocks for all three config files.
   🔴 **DIAGNOSED 2026-08-08 — it was never a rate limit. A BODY FIELD WAS MISSING: `Haiku`.**
   The cold-start test refuted the throttle theory: after ~15 hours of silence, one attempt with
   the full captured field set returned the **byte-identical** empty body (`HTTP 200,
   content-encoding=none, 0 raw bytes`). **A throttle does not survive 15 hours.**
   🔑 **The answer then cost ZERO logins.** Diffing the app's HAR *structurally* — field and
   header NAMES only, never values — showed the app sends **24** body fields and this client sent
   **23**; the one name missing was `Haiku`. ✅ Fixed: `haiku` option + `ADC_MOBILE_HAIKU`, and
   the CLI now **refuses to run without it** rather than spend a login on a known-bad request.
   ✅ Two more findings from the same offline diff: **all 18 hardcoded constants already matched
   the app exactly**, and **`HashCode` is NOT a timestamp** (off by ~1188 days from the capture's
   own `startedDateTime`) — it is stable per install and a captured one is reusable.
   ➡️ **Next: ONE attempt with `ADC_MOBILE_HAIKU` set.** 🔴 Still do not permute.
   🔎 Traps already paid for: an incomplete field set returns a **zero-byte** body with no error
   (the client now explains this in the error rather than reporting it); the response is
   **gzipped and `fetch` does not decode it**; and a REJECTED login still returns HTTP 200, so
   only `lr` distinguishes success.
   🔑 **The generalisable lesson, and it is the expensive one:** the refutation AND the answer
   both came from evidence **already on disk** — the capture predates all nine attempts.
   Offline comparison against a known-good request costs nothing and risks nothing; probing a
   live auth endpoint costs a login against a lockable account. **Exhaust the diff first.**

4. **(David — a decision, not code)** `PublicRtspEndpoint` publishes each camera's port on the **WAN**
   address: digest-auth RTSP behind a self-signed certificate that expired Dec 2024, reachable from
   the internet, almost certainly created by UPnP. Not probed from outside. Worth deciding on
   deliberately rather than inheriting. ⚠️ More pointed now that local RTSP is the production path.

5. **(Agent, small)** `api.local_auth: false` in the deployed `config/go2rtc.yaml`; the example and
   `SECURITY_AUDIT.md` both specify `true`. Exposure is nil today only because `api.listen` is the LAN
   address — so the protection comes from the bind address, not the setting. `npm run verify:config`
   warns about it.

6. ✅ **DONE 2026-08-08 — `scripts/scan-secrets.mjs` + `.githooks/pre-commit`, and it EXITS 1.**
   There was never an installed scan; what the old wording called "the scan" was an agent running
   `grep` by hand, which is why nothing blocked.
   🔑 **Enable once per clone — it is not automatic:** `git config core.hooksPath .githooks`.
   Also `npm run scan:secrets`, and `--range A..B` / `--stdin` for checking history.
   Rules: RTSP credentials, HomeKit `pairings`/`device_private`, MACs, long hex, camera ids,
   private IPs (against an **allowlist** of documented examples), and `Haiku` **anchored on its
   key**. Escape hatch: `leak-scan-ok` on the line.
   ⚠️ **Scans ADDED lines in the staged diff, never the tree** — the repo already contains real
   values in history, and a whole-tree scan would fail every commit and be switched off in a day.
   ⚠️ It prints the rule and location but **truncates the matched value**: a scanner that echoes
   what it found is itself a way to leak it.
   🔑 **It caught a real mistake on its first run against history** — the **NAS's own LAN
   address** had been used as a fixture in `src/setup/steps.test.ts` earlier the same day.
   Changed to a documentation-range address. ⚠️ The original is committed in `df03624` and stays
   in history. 💡 The scanner then blocked the very commit that documented it, because this
   bullet originally quoted the address literally. Working as intended.
   💡 A first draft matched `Haiku` by SHAPE (ten words, ~60 chars, ending in a period) and
   flagged four passages of this repo's own prose. That shape is just an English sentence. The
   rule is now key-anchored, which does mean a bare value pasted without its key is not caught —
   accepted, because a scanner that fires on every paragraph gets disabled.

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
12. ✅ **DONE 2026-08-08 — `npm run discover:local -- --write`** merges the generated blocks into
    `config/config.yaml`, `.env` and `config/go2rtc.yaml` in place. `src/config-writer.ts` is the
    merge as pure `string → string`; `src/config-writer-fs.ts` applies it to disk. 24 new tests.
    🔴 **REFUSES `config/go2rtc.yaml` once anything is paired** — go2rtc writes that file itself and
    `device_private` is unrecoverable — and falls back to printing the block. Merges into existing
    maps (never appends, so no duplicate key), never overwrites an existing key, backs up first at
    0600, preserves comments, refuses a file it cannot parse.
    🔑 Both guards **mutation-tested in both directions**: the paired-refusal fails 2 tests when it
    can never fire and 6 when it always fires; dropping the unconditional `chmod` fails 1.
    ⚠️ **Still UNPROVEN end-to-end** — no live sign-in has ever succeeded (item 3), so `--write` has
    never run against real Alarm.com output. The merge layer is covered; the path from a real
    `<lnr>` response into these functions is not.
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

16. ✅ **DONE 2026-08-08 — `npm run setup`, one command, steps 1-7.** Preflight → credentials →
    ONE login → write → **verify gate** → `compose up --build -d` → pairing codes.
    `src/setup/steps.ts` is the pure decisions, `src/setup-cli.ts` the orchestration.
    🔴 **It does NOT generate `docker-compose.yml`** — every per-install value there is already a
    `${VAR}` substitution, and a generated copy would be a second, unaudited statement of the
    security posture `SECURITY_AUDIT.md` describes. The installer orchestrates; it never emits.
    🔑 **Re-runnable without spending a login** — discovery is skipped when `config.yaml` already
    has cameras (`--rediscover` forces it). 🔑 Step 5 **exits 1** on any blocking finding.
    ⚠️ **Two defects found by RUNNING it, that the unit tests could not see:** re-runs generated
    fresh secrets for keys that already had one, manufacturing a conflict; and the conflict
    message then **echoed the stored credential to stdout**. Both fixed —
    `buildEnvAdditions` takes the existing env, and `mergeEnv` redacts unless the caller opts in
    per key via an allowlist.
    💡 `.env.example` was briefly believed incomplete; it is NOT — see the regex note in "Do not
    touch". A test now pins it against compose's `${VAR:?}` guards either way.

15. ✅ **FIXED 2026-08-08 — `listenPort` is ALLOCATED, never positional.**
    `allocateListenPorts()` in `src/config-writer.ts` reserves every port the existing
    `config.yaml` holds, keeps a already-configured camera on its stored port, and hands new
    cameras the next free number. `portRangeCovering()` spans min→max rather than `base + count`,
    so a gap (a removed camera, ports allocated across runs) cannot leave the highest port
    unpublished. Both CLIs use them; `discover:local` now reads the existing config **even in
    print mode**, so a printed block is safe to paste into a config that already has cameras.
    🔑 The bug: `mergeConfigYaml` skips a camera whose `id` exists, so an EXISTING camera kept its
    stored port while a NEW camera at a lower index got the same number — two relays, one port.
    ⚠️ It hid because the first live run matched production exactly — but only because Alarm.com
    happened to return the cameras in the order the config was written. **That match validated the
    API parsing, NOT the port assignment.** 10 tests, including a case that reproduces the
    collision (a new camera sorting ahead of a configured one).

### Do not touch / gotchas

- 🔴 **`[A-Z_]+` DOES NOT MATCH `GO2RTC_*` — the name contains a digit.** This produced three
  confident false negatives in one session (2026-08-08): a compose grep that "found" only one
  required env key instead of five, a pinning test that agreed with nothing, and a claim that
  `.env.example` was missing four keys **when it has always had them**. Every check silently
  reported clean. **Use `[A-Z0-9_]+`** for env-var names here, and pair any such extraction with
  a positive control asserting it finds a digit-bearing name — a too-narrow pattern and a correct
  one produce identical clean output.

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or
  captured frames. **This applies to this file too.**
- 🔎 **Everything else that used to be listed here now lives in [`INVARIANTS.md`](INVARIANTS.md)** —
  the "no video" diagnosis order, the `endToEndWebrtcConnectionInfo: null` trap, the ~37s
  stale-callback fix, session-callback ownership, the two circuit-breaker rules, and the Homebridge
  and Synology invariants. **Search it before changing any of those.**

### Open decisions

- 🔴 **DAVID: decide whether to rotate a camera's RTSP password.** On 2026-08-08 an agent printed
  `config/go2rtc.yaml` lines 17-22 to check the `log:` edit; line 22 begins `streams:`, so **one
  camera's RTSP username and password went into a session transcript in clear text.** Nothing was
  committed and the file on disk was not altered by it. The exposure is only as wide as that
  transcript. ⚠️ **The lesson for agents: redacting `key: value` lines is not enough** — the same
  read also printed every `pairings:` list ITEM (client_id / client_public) because the filter
  matched only `key: value` and not list entries. Redact by BLOCK, never by line pattern, and never
  print a line range from that file without knowing which block each line falls in.
  🔴 **It then happened a SECOND time, the same day, a different way.** A filter redacting any key
  matching `/pass|token|secret|url|host|user/` printed the status endpoint's `relays[].target`,
  putting all three **camera LAN IPs** in a transcript — the field is called `target`, so it matched
  nothing. 🔑 **That is the real rule: a DENYLIST fails open.** Both leaks were denylists that had
  simply not anticipated the field. Name what to SHOW (an allowlist fails closed), and say plainly
  what was withheld so the omission is visible rather than assumed.

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
