# Baton archive — completed items, moved 2026-08-31

The thirteen closed items from `docs/AGENT_HANDOFF.md`'s "What's left" list, moved here
**unedited** on 2026-08-31 because they were 58% of a file that is read in full every session.
Every one is ✅ DONE / SETTLED / FIXED or 🚫 MOOT / CLOSED. The four items still open stayed in
the baton.

🔴 **Do NOT start a new log here.** This file only ever receives items moved out of the baton.
New work goes in the baton; narrative goes at the top of `Journal.md`.

Items are in numeric order. In the baton they were not: 16 sat above 15, in a list labelled
"priority order".

Search it:

```bash
grep -n "listenPort\|scan-secrets\|discover:local" docs/journal/2026-08-31-baton-completed-items.md
```

---

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

