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
- **Updated:** 2026-08-11. ✅ **THE COMMUNITY BLOCKER IS CLOSED (item 3).** A live
  `mobile.alarm.com` sign-in works and reproduces the hand-built production config field for field.
  The cause of every earlier failure was one missing body field, `Haiku`.
  Architecture unchanged since 2026-08-07: all three cameras in HomeKit over their **own local
  RTSP**, go2rtc's native client, in-process HKSV, **zero ffmpeg in the media path**. Both
  ADC-V515s worked when connected. Motion from go2rtc's own detector, so **Alarm.com is out
  of the video path entirely**.
  🔴 **AS OF 2026-08-25 ONLY THE ADC-V723 (front) IS STREAMING.** Both ADC-V515s are
  **not connected to the network** (confirmed by David, and by `EHOSTUNREACH` on a TCP connect
  to their configured endpoints from the NAS). This is NOT a config or code fault and NOT
  caused by the go2rtc rebuild. Their HKSV recording has been dead for up to 17 days.
  ➡️ Nothing to fix here until the cameras are back on the network. When they are,
  re-check the endpoints: if the addresses moved, `config.yaml` is stale and `discover:local`
  is what refreshes it. 📖 `Journal.md` 2026-08-08.
  🔑 **Also closed since:** `npm run setup` (one command, preflight → sign-in → write → verify gate
  → compose up → pairing codes), `discover:local -- --write`, a **blocking** pre-commit secret scan,
  the media watchdog, the ICE-disconnect grace period, and allocated (not positional) `listenPort`.
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
  ⚠️ **The NAS is DELIBERATELY behind `main`.** What it is behind by is a count; get it from
  `git log --oneline 37d1236..main`.
  🔴 **THE GAP IS NO LONGER DOCUMENTATION-ONLY. As of 2026-08-25 a rebuild CHANGES go2rtc's SOURCE.**
  `main` now pins `Mo3he/go2rtc@2464e567` instead of `skrashevich/go2rtc@506cfa7`, and the local HAP
  patch is deleted. That is verified and intended (see Open decisions) but it is **not what is
  running**, so `docker compose up --build` is no longer a no-op dressed as a rebuild.
  ➡️ **Before rebuilding go2rtc, tag the current image so rollback is one command**, and expect the
  go2rtc container to restart on a paired, recording install.
- **Validation:** run **2026-08-11 against `6e247a2`**, all three green: `npm run build` clean,
  `npx vitest run` **26 files / 436 tests**, `npm run audit:prod` passes with the documented
  GHSA-2p57-rm9w-gvfp exception. ⚠️ Re-run before trusting.
  🔴 **A pre-commit secret scan now BLOCKS.** Enable it once per clone, it is not automatic:
  `git config core.hooksPath .githooks`. Also `npm run scan:secrets`. It caught three real leaks on
  its first day, including two in commits an agent was in the middle of making.
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
- ✅ **`log: { homekit: trace }` REMOVED 2026-08-08 (David).** `config/go2rtc.yaml` has just
  `log:` → `level: info`.
  ⚠️ **Consequence: there is NO motion visibility at all**, and it is currently blocking a real
  question (see whose-turn). `motion: ON` is a **DBG** line, so at `info` no trigger is ever
  logged. 🔑 To tune thresholds, set `log: { homekit: debug }` — **not `trace`**: DBG keeps
  `motion: ON` and drops the 1-in-150 `motion: status` flood.
- 🔑 **go2rtc logs in UTC; local is UTC-5. 3am local = `08Z`.** Its inline clock equals Docker's
  `-t` stamp exactly. A `16:05` line is 11:05 local — already mis-read once as "afternoon".
- 🔑 **Upstream (Omar-L): 2 merged, 7 open PRs, 3 issues.** Newest are **PR #34** (media watchdog)
  and **issue #35** (the local RTSP finding, offered rather than PR'd). #32 was `CONFLICTING` and
  was rebased 2026-08-08. Details and the rebase-verification recipe: [`UPSTREAM.md`](UPSTREAM.md).
  ⚠️ We carry a **local go2rtc patch** for the HAP auth defect (`patches/`, applied in
  `Dockerfile.go2rtc` over a pinned commit). Reported on go2rtc#2130. **Delete the patch when it
  lands upstream** — until then it is a liability that rots when the pin moves.
- **Whose turn:** **DAVID.** Nothing is broken and **the agent backlog is empty.** Items 2, 3, 5, 6,
  9, 10, 12, 13, 14, 15 and half of 8 are closed; 4 is decided; 11 and 13 are moot rather than
  pending. Everything written this cycle is LIVE: go2rtc restarted, Homebridge restarted, `main`
  pushed.
  🔴 **(1) The one item with a clock on it: is kitchen at 4.0 too sensitive?** Relay
  `totalConnections` went 3 → 198 on kitchen after the threshold drop, roughly one HKSV recording
  every 83 seconds. **One glance at the Home app timeline settles it.** Flooded ⇒ raise toward
  4.5-5.5. See item 2. ⚠️ It cannot be confirmed from logs while `log:` is at `info`.
  ⚠️ **(2) The mobile-API capture values may be GONE.** Only one file survives in `~/Downloads`
  and it is not the login capture. If `ADC_MOBILE_HAIKU` / `DEVICE_UID` / `HASH_CODE` /
  `TWO_FACTOR_ID` are not saved elsewhere, the next `discover:local` or `npm run setup` needs a
  fresh proxied capture. Cheap to check now.
  🔑 **(3) The remaining leverage is a QUESTION, not code:** is `Haiku` per-install or a client
  constant? If constant, the proxy-and-CA-cert step disappears and onboarding really does become
  username + password. Asked publicly in issue #35; one other person's capture answers it free.

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
   🔴 **WITHDRAWN 2026-08-25 — the 08-08 reconnect reading was WRONG. Do not act on it.**
   On 08-08 relay `totalConnections` went 3/3/3 to 19 (front) / 198 (kitchen) / 6 (sunroom) after
   the threshold change, and that was read as the lowered threshold causing constant HKSV
   recordings, argued from a "dose-response" match: kitchen dropped furthest and moved most.
   🔑 **The real cause was that kitchen and sunroom were going OFFLINE.** By 08-25 sunroom sat at
   41,966 reconnects with its threshold **never changed**, and both failing cameras are ADC-V515
   while the working one is the ADC-V723. The pattern is liveness-correlated, not
   threshold-correlated. ⚠️ **The thresholds are FINE.** They stay at 4.0 / 4.0 / 3.5, and the
   "is kitchen too sensitive" question is closed, not pending.
   🔑 **Worth keeping, because the wrong answer stood for 17 days:** three data points plus a
   plausible mechanism produced a confident dose-response story, and the confounder was sitting in
   the same table being read.
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

4. 🔴 **(DAVID — a decision only you can make; an agent cannot execute or verify it.)**
   `PublicRtspEndpoint` publishes each camera's port on the **WAN** address: digest-auth RTSP behind
   a self-signed certificate that expired Dec 2024, reachable from the internet, almost certainly
   created by UPnP.
   ✅ **DECIDED 2026-08-08 by DAVID: LEAVE IT AS IS. Do not re-open this; do not "fix" it.**
   The agent recommendation was to disable it, and David weighed that and declined. Both sides are
   recorded so the decision is not re-litigated every time someone notices the exposure:
   - *For turning it off:* nothing in this project has ever used it — production is
     `LocalRtspEndpoint` via the relay, and the WebRTC path used the cloud. So it buys zero
     function, while being an internet-facing service on three cameras whose firmware is not
     patched here.
   - *For leaving it:* the only control point is **UPnP on the router (an eero Pro 7, identified
     read-only by SSDP from the NAS — nothing probed from outside)**, and disabling UPnP is
     **network-wide**, so consoles and P2P apps lose their own port-opening too. That is a real cost
     for a theoretical risk.
   🔴 **What would REOPEN it** — none of these are true today: a camera-firmware CVE with a public
   exploit; evidence of the WAN ports being hit; or the per-camera RTSP passwords becoming public.
   ⚠️ **On that last one:** all three camera RTSP passwords were put into an agent transcript on
   2026-08-08 (see "Open decisions"). A transcript is not a public paste, so this does not by itself
   flip the decision — but those passwords are the ONLY control on the WAN endpoint, so if the
   transcript's handling ever changes, this decision changes with it.
   💡 The control, if it is ever wanted: eero app → Settings → Network Settings → UPnP. An agent
   cannot reach it — phone app, David's account. A second IGD on the LAN is a Philips Hue bridge,
   not the gateway; don't chase it.
   ⚠️ **Still not probed from outside, deliberately.** Confirming it from the internet means port
   scanning your own WAN address, which an agent should not do unasked; and a negative result would
   be weak evidence anyway, since UPnP mappings come and go with camera reboots. Check the router's
   UPnP table instead — that is the authoritative view and it needs no probing.

5. ✅ **DONE ON DISK 2026-08-08 — `api.local_auth: true`. ⏳ NOT LIVE until go2rtc restarts.**
   `verify:config` is now **0 blocking, 0 warnings** (was 1 warning all session). Backup:
   `~/go2rtc.yaml.bak-20260808-154429` on the NAS, mode 600.
   🔑 Safe because go2rtc runs `network_mode: host`, so requests arrive from the LAN address and
   are never loopback — auth already applied in practice. The setting closes the gap between what
   protects it (the bind address) and what `SECURITY_AUDIT.md` claims protects it (the setting).
   The compose healthcheck expects a 401 and gets one either way.
   ➡️ `sudo docker-compose restart go2rtc` at any convenient moment; nothing is broken meanwhile.

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

8. ⚠️ **HALF DONE 2026-08-08.**
   ✅ **Media watchdog — FIXED.** `tryConnect()` now awaits actual media after `SESSION_STARTED`
   (`MEDIA_TIMEOUT_MS = 20s`) and fails the attempt if no track arrives, so a trackless session is
   no longer recorded as a success that resets the breaker. On timeout it `stop()`s first and then
   sets `'error'` — that ORDER matters, since `stop()` sets `'idle'` — which also tears down the
   ffmpeg and socket a timeout would otherwise leak once per retry.
   🔑 `awaitMedia()` returns immediately if a track already arrived: `onTrackReady` can fire before
   `connect()` settles, and a watchdog that missed that race would fail a healthy stream.
   🔑 Mutation-tested three ways — never-fires kills 3 tests, always-fires kills 1, and removing
   the waiter-clear in `stop()` kills 1.
   🔎 **This is the most upstreamable thing here:** `camera-stream.ts` is code Omar-L actually
   runs, unlike anything on the local-RTSP path. See [`UPSTREAM.md`](UPSTREAM.md) — branch off
   `upstream/main` and verify against THEIR lockfile.
   ⏳ **STILL OPEN:** a camera never attempted reports `idle` with zero errors for ~30 min, until
   the token breaker opens (`VIDEO_TOKEN_FAILURE_THRESHOLD = 3` × `VIDEO_TOKEN_REFRESH_MS = 600s`).
   ⚠️ Lower value than it looks: it is WebRTC-path only, and the production path is local RTSP.
   💡 The local-RTSP relay already has the equivalent guard — `idleTimeoutMs: 120_000` in
   `tunnel-relay.ts`, armed on connect and reset per chunk — so a relay session that never carries
   data does get closed. Checked 2026-08-08; do not "add" it again.
   🔑 Both defects are the trap `README.md` documents one layer up — *"did not produce a usable
   result"* is the failure, not *"threw"* — never applied downward. 📖 `Journal.md` 2026-08-06.
9. ✅ **DONE ON DISK 2026-08-08 — ⏳ needs a Homebridge restart to take effect.**
   The `Camera-ffmpeg` platform (one camera, "Front Camera") is removed from
   `/volume1/homebridge/config.json`: 8 platforms → 7, JSON re-parses, `accessories` untouched.
   🔑 **`Alarmdotcom` is deliberately KEPT** — that platform is the alarm panel, sensors and locks,
   nothing to do with video. Verify it survived before restarting.
   Backup: `/volume1/homebridge/config.json.bak-20260808-160405`. ⚠️ It is owned by **dpeak (1027)**,
   not the homebridge user (108668), because an ssh session created it — `chown` it back before
   restoring, or Homebridge cannot read it.
   ⚠️ **User-visible on restart:** "Front Camera" disappears from the Home app, automations
   referencing it break, and its HKSV history goes. The native go2rtc "Front" accessory is separate
   and unaffected.
   💡 The bridge side needed nothing — `config.yaml` has had no `homebridge:` section for a while,
   so no motion was being posted there anyway.

10. 🔴 **(David — needs sudo) `/volume1/homebridge/config.json` is `777`, not the `775` recorded
    here — it is world-WRITABLE.** Any account on the NAS can rewrite Homebridge's config.
    `INVARIANTS.md` sets 600 as the standard.
    ```
    sudo chmod 600 /volume1/homebridge/config.json
    ```
    ⚠️ **An agent cannot do this**: the file is owned by uid 108668 (homebridge) and an ssh session
    is uid 1027, so `chmod` returns "Operation not permitted".
    ⚠️ **Not durable.** The volume's default ACL is 0777 and the Homebridge UI rewrites the file, so
    this resets. Re-check after any Homebridge settings change — writing to the file through the UI
    or a script re-inherits the ACL, which is how it reached 777.
11. 🚫 **MOOT on the production path — do not pick this up as written.** `-reorder_queue_size 0`
    is an **ffmpeg** flag, and since local RTSP was adopted there is **no ffmpeg in the media
    path** — go2rtc pulls the relay with its native client. The `Non-monotonic DTS` lines came
    from the WebRTC path's ffmpeg, which nothing here now runs.
    ⚠️ Still real for anyone on the WebRTC path (upstream included), so it is not deleted — but it
    cannot be A/B'd here without first standing a camera back up on WebRTC, which would be work
    done solely to enable the measurement.
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
13. 🚫 **CLOSED 2026-08-11 — THESE CAMERAS HAVE NO AUDIO. Not a task, and not path-specific.**
    Alarm.com's own per-camera capability flags read **false on all three**, for all four audio
    fields: `SupportsDownstreamAudio`, `SupportsUpstreamAudio`, `SupportsFullDuplex`, `IsAudioOnly`.
    One ADC-V723 and two ADC-V515.
    🔑 So the missing `m=audio` line in the local RTSP SDP is a SYMPTOM, not the cause. Earlier
    wording blamed the local RTSP path; the truth is upstream of it and no path can do better.
    ⚠️ Scope: this is what Alarm.com *reports*, not a hardware teardown. A V723 may physically have
    a microphone that Alarm.com does not expose. No practical difference to this project.
    ➡️ **Do not re-investigate.** Evidence: the mobile API camera list (JSON form), from the
    2026-08-07 capture, read 2026-08-11.
14. ✅ **FIXED 2026-08-08 — ICE `'disconnected'` is now debounced, not terminal.**
    `peer-session.ts` fails immediately on `'failed'` (terminal) but gives `'disconnected'`
    `ICE_DISCONNECT_GRACE_MS = 8s` to recover; any other state stands the timer down. A repeat
    `'disconnected'` does NOT re-arm, and `close()` disarms.
    ⚠️ **The 8s is NOT measured** — it is chosen from how ICE behaves generally, since these
    cameras now run local RTSP where this code never executes. It is a named constant so someone
    watching a real WebRTC session can tune it. 🔑 The number is not the point: any grace at all is
    correct where zero is not.
    🔑 **Mutation-tested four ways, and TWO of the mutations initially survived** — both were gaps
    in the tests, not the code. (a) `close()`'s `clearDisconnectGrace()` is defence in depth: the
    timer callback already guards on `closed`, so only asserting the timer HANDLE distinguishes
    "cleared" from "left pending and ignored". (b) Removing the re-arm guard does not restart the
    clock, it LEAKS a second timer — the first still fires on schedule, so a short window sees one
    call either way; the duplicate only appears past the second timer's own deadline.
    💡 The old entry said the timeout could not be chosen without a real camera. True, and it still
    is — but that argued for a *named constant with the uncertainty written down*, not for leaving
    a known-wrong immediate teardown in place.
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

17. ✅ **FIXED 2026-08-25 — the relay now reports a camera that stops delivering.**
    `TunnelRelay` counts consecutive sessions that close having carried under `healthyBytes`
    (4 KiB) from the camera. At `unhealthyAfter` (10) it logs **once** at `error` naming the
    target and what to check, and `getDiagnostics()` gains `consecutiveFailures` and `healthy`,
    which the status endpoint already passes through verbatim.
    🔑 **It keeps retrying.** `healthy: false` does not mean stopped — the camera may come back.
    It means stop believing the silence. A working session resets the run and logs recovery once.
    🔑 **Logs ONCE per episode, deliberately.** A line per failed session would reproduce the
    original problem from the other side: ~45,000 lines nobody reads is as good as silence.
    🔴 **AND a stall check, because failure-counting ALONE was not enough.** Its first live
    deploy reported two definitively dead cameras as `healthy: true`: go2rtc had stopped
    connecting to them, and a relay with **no sessions has no failures to count**. That is the
    same blind spot the fix existed to remove, reproduced inside the fix.
    `healthy` is now churn-free AND not silent: `msSinceDelivery` past `stalledAfterMs`
    (10 min) is unhealthy on its own, reported once from the 60s status tick so a relay nobody
    connects to still speaks. ⚠️ It assumes the stream is **continuously consumed**, which
    `motion: detect` guarantees; set `stalledAfterMs: 0` for an on-demand deployment.
    🔑 Mutation-tested four ways. ⚠️ **One mutation initially SURVIVED** — removing the byte
    accumulation from `get.on('data')` broke nothing, because every healthy-path test delivered
    its bytes via `trailing`, which arrives with the tunnel header and is counted through
    `leftover`. That gap mattered more than it looks: had the streaming path stopped counting, a
    WORKING camera would be declared unhealthy. Covered now by a test that writes to the camera
    socket after the tunnel opens.

    *(the defect, kept because the reasoning is the reusable part)* **The relay used to retry
    forever and never escalate.** Kitchen and sunroom were unreachable for up to 17 days. In that time the
    relay opened **~45,000 and ~42,000 connections** that delivered almost no bytes, and **nothing
    said so**: no log line, no alert, no status flag, and `verify:config` reported 0 blocking
    throughout, because it validates configuration and not liveness.
    🔑 This is the trap `README.md` documents one layer up — *"did not produce a usable result"
    is the failure, not *"threw"* — never applied to the relay. The WebRTC path has circuit
    breakers; the relay has none.
    🔑 **The signal is already collected and unused.** `TunnelRelay` tracks `totalConnections`
    and `bytesDown` per camera. A working camera holds ONE long connection and moves a lot of data
    (front: 991 connections, 266 GB). A dead one churns and moves almost none (kitchen: 45k
    connections, 3.5 GB). That ratio IS the health check.
    ➡️ **Fix shape:** count consecutive connections that close having delivered under N bytes;
    at a threshold log once at `error` and expose it on the status endpoint. Do NOT stop retrying,
    the camera may come back — stop failing *silently*.
    ⚠️ **Diagnosis worth reusing:** a TCP connect to `localRtsp.host:port` from the NAS.
    `EHOSTUNREACH` means nothing is at that address, separating "camera moved or is off" from
    "camera up but stream broken" in one second, with no login and no logs.

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

- 🔑 **(DAVID) Move the go2rtc build from `skrashevich@506cfa7` to `Mo3he/go2rtc@2464e567`?**
  ✅ **MERGED to `main` 2026-08-25 (`35c4e77`) and pushed. ⏳ NOT DEPLOYED.** `main` now builds
  the new source; the NAS still runs the old image. Nothing changes until someone rebuilds there.
  The change repoints `Dockerfile.go2rtc`, deletes `patches/go2rtc-hap-auth-exempt.patch`, and
  updates `SECURITY_AUDIT.md` provenance and `INVARIANTS.md`.
  ⚠️ **NOT verified: the docker build itself.** The daemon was not running on the Mac, and an
  arm64 build would not have proven the linux/amd64 NAS build anyway. The Go build WAS verified
  natively with the exact command the Dockerfile runs. **The NAS rebuild is the first real test of
  the container build**, so do it when you can watch it, not unattended.
  **Verified 2026-08-25, locally, touching nothing on the NAS.** His `hksv` branch is our exact pin
  plus 25 commits, **0 behind**, so nothing is lost.
  ✅ Builds clean (`CGO_ENABLED=0 go build ./...`), `go vet` clean, HKSV + HAP suites pass.
  ✅ **Breaks nothing:** zero packages that pass on our pin and fail on his.
  ✅ **Fixes two packages that FAIL ON OUR PRODUCTION PIN TODAY** — `pkg/hap/tlv8` and
  `pkg/hap/camera`. The tlv8 one is real: the separator between repeated tags is emitted as `0xff`
  where it must be `0x00`, and `506cfa7` ships that test already failing.
  ✅ **`patches/go2rtc-hap-auth-exempt.patch` becomes REDUNDANT** — it no longer applies, and his
  `6f76ea9a` implements the same fix better, registering `hap.PathPairSetup`/`PathPairVerify` via a
  new `api.HandleFuncNoAuth` instead of hardcoding the strings in the middleware. It credits the
  report: *"Reported by dppeak on AlexxIT/go2rtc#2130."*
  💡 Also gains `94cea2d1`, which derives the mDNS config number from the accessory database, so
  changing `hksv` config on an already-paired camera no longer forces a re-pair.
  🔴 **What makes this a decision and not a chore:** it is a **different maintainer**.
  `SECURITY_AUDIT.md` documents the provenance as `skrashevich/go2rtc`, so moving is a
  supply-chain change that must be recorded there, not a quiet pin bump. ⚠️ Not all 25 commits are
  HKSV work — one is a merge from upstream `master` bringing unrelated changes (PCMA/PCMU probe
  fixes, a README link).
  ⚠️ Deploying needs David's sudo and restarts a **paired, working, recording** install. The eight
  other full-suite failures are identical on both commits, so they are environmental, not his.


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
