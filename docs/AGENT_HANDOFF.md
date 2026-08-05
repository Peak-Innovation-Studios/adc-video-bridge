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
- **Updated:** 2026-08-04 (later still) — **merged native-HKSV Phase 0** (14 commits): go2rtc split
  into its own container, bridge authenticated against it. Narrative: `Journal.md`, entry
  "2026-08-04 (later still)". Earlier the same day: make-before-break merged, and this baton split.
- **Branch / HEAD:** Run `git fetch && git status -sb && git log --oneline -1`. `main` is the branch
  to deploy from. **Pushing here does NOT deploy** — Kaikoura is updated by hand, and `src/` changes
  need `docker-compose up -d --build`.
  💡 "Do I need a rebuild?" is answerable from git alone: the Dockerfile copies only `package*.json`,
  `tsconfig.json`, `src/` and `entrypoint.sh`, so
  `git diff --name-only <deployed-commit>..main -- <those paths>` empty ⇒ the image is current.
- **Working tree:** Run `git status --short` **and `git stash list`**. Both are empty as of this
  handoff, and the `make-before-break` worktree and branch are **merged and deleted** —
  `git worktree list` should show only the main checkout.
  ⚠️ **Check the stash every session; a clean `git status` actively hides it.** A stash from
  2026-08-03 (`upstream-fix/log-redaction`, `src/utils/logger.ts`) survived two days and a branch
  merge unnoticed for exactly that reason. It was verified **byte-identical** to `HEAD` and dropped
  2026-08-04 (`ebe41f5`, recoverable from the reflog for ~90 days). 🔑 Before dropping any stash,
  compare content rather than trusting `git apply --check --reverse`, which is context-tolerant:
  `diff <(git show stash@{0}:<path>) <(git show HEAD:<path>)`.
- **Validation (as of the commit this baton describes — re-run before trusting it):**
  `npm run build` clean, `npx vitest run` **14 files / 214 tests**, `npm run audit:prod` passed with
  the documented GHSA-2p57-rm9w-gvfp exception.
  ✅ **Agent worktrees no longer double-count the suite.** They live under `.claude/worktrees/`
  *inside* the repo, so their copy of `src/` used to match vitest's include glob and every run
  counted twice (12/180 → 24/360). `vitest.config.ts` now excludes `**/.claude/**`. ⚠️ If you ever
  edit that `exclude`, **spread `defaultExclude`** — setting it replaces the defaults, and in
  vitest 4 those are only `node_modules` and `.git`.
- 🔴🔴 **ROOT CAUSE: THE CAMERA IS FLAPPING.** It reports **offline in the Alarm.com app itself**,
  intermittently. Measured here: a period of healthy streaming (152–155 KB frames, 3/3 distinct
  md5s, ffmpeg up, HomeKit live) followed within minutes by **0 of 9 samples over 3 minutes**.
  This is not our code, not proxy-vs-direct, and not the rebuild.
  🔑 **THIS EXPLAINS EVERY CONTRADICTION FROM 2026-08-04, and it is the lesson worth keeping.**
  Observations taken minutes apart were treated as one consistent picture — app works / web fails /
  HomeKit works / all three work / all down. They were **samples of an oscillating system**, not
  facts to reconcile. ⚠️ **With an intermittent fault, sequential measurements cannot be combined.**
  Every theory built that way ("demoted to Proxy", "camera offline", "different subnet", "our
  session locks out the web player") failed on the next sample, and each was a reasonable reading of
  the sample it came from. **Measure the same thing repeatedly over time before explaining
  anything.**
  ⚠️ **Both exonerations still hold** — they were established by *controlled* tests, not snapshots:
  the code by a rollback to `2e98710` that failed identically, and the bridge/go2rtc/auth stack by
  direct inspection. The camera is the variable.
  ➡️ **Item 1 is REOPENED. Better signal strength did not deliver a stable connection.** The camera
  moved to a closer AP with stronger signal and is *still* dropping, so RSSI was the wrong metric.
  Suspects, in order: **roaming/band-steering flap** between mesh nodes (the classic cause of a
  strong-signal-yet-unstable client), channel interference on the new AP, or camera power. Try
  **pinning the camera to one AP and one band** (disable band steering / set a fixed BSSID if the
  mesh allows) and watch the AP's client list for it bouncing between nodes.
  💡 **The bridge needs no intervention through any of this.** `TokenManager`'s unconditional 600 s
  interval restarts the chain and the breaker self-heals, so video returns on its own each time the
  camera does. Do not restart containers to chase this.
- 🔬 **OPEN AND IMPORTANT — does Alarm.com allow only ONE e2e session per camera?** During the
  outage the **web player did not work while the bridge was streaming**. The likeliest reading is
  that our *perpetual* session holds the only e2e slot, locking out ADC's own web player. **If true,
  make-before-break's central assumption is wrong** — the overlap could never hold two sessions and
  would always fall back to break-before-make, meaning the ~1.2 s gap is not actually closed.
  **How to settle it — use these EXACT strings** (an earlier version of this baton said only "grep
  for the refusal line", which is not enough: the *positive* case has its own message and is the one
  that actually proves the design works). Needs sudo; use a large tail, since a status line prints
  every 60 s:
  ```
  sudo .../docker-compose logs --tail=3000 adc-video-bridge | grep -E \
    "Seamless reconnect|stays live during overlap|waiting for first RTP to cut over|\
Second concurrent session refused|Overlap did not complete|died mid-overlap"
  ```
  | Line | Verdict |
  |---|---|
  | `Pending session connected, waiting for first RTP to cut over` | ⭐ **two sessions ALLOWED — the design works** |
  | `Second concurrent session refused by Alarm.com` | one session only ⇒ overlap is a permanent no-op |
  | `Overlap did not complete; keeping the current session` | second session opened, no RTP within budget |
  | `Active session died mid-overlap` | fallback path ran |
  | **no `Seamless reconnect` at all** | nothing has been observed yet — the reconnect path only runs
    when already `streaming` and a token arrives (~600 s). Wait and re-run; an empty grep is **not** evidence. |
  A second, independent check from the other side: with the bridge streaming, try the **web player**
  — if it reliably fails only while we are connected, that points the same way.
- 🔴 **An agent CANNOT do the rebuild — do not plan around it.** `sudo` on Kaikoura requires David's
  password (verified 2026-08-04: `sudo -n` fails, and `docker` needs privileges), and every compose
  command in [`SYNOLOGY.md`](SYNOLOGY.md) is sudo-prefixed. SSH itself works fine as `dpeak`, so
  read-only inspection of the checkout **is** available to an agent — see the sudo-free tools below.
  ⚠️ Do not run the `git pull` half on its own to "get ahead": pulling source does not replace the
  running image, and it desyncs the checkout from the image, which silently invalidates the rebuild
  test above. Run the documented sequence intact, or not at all.
- 📋 **BASELINE — what "healthy" looked like on the OLD image (`2e98710`), for comparison.** This is
  history now, not current state: go2rtc answered `401` unauthenticated, served **84–127 KB**
  distinct-md5 JPEGs, had a real `rtsp+tcp` publisher, and **0** WebSocket 401s (was ~60/hour).
  Use it as the bar the rollback or the fix must clear. Motion, doorbell, audio and HKSV are
  disabled in both images.
  ⚠️ **Never confirmed even on that image: whether the breaker actually opened or probed in anger.**
  Needs `docker-compose logs` (sudo) — grep `Circuit OPEN`, `probing`, `Circuit closed`.
- **Sudo-free diagnosis on Kaikoura:** `node dist/probe.js <cameraId>` and `node dist/discover.js`
  work from the checkout after `set -a; . ./.env; set +a`. Use these instead of `docker exec`, which
  needs David's password. `node_modules`/`dist` there are gitignored.
- **⬆️ Eight upstream PRs and two issues are open at Omar-L, all awaiting his review.** Nothing is
  blocked on us. Table, held branches, and the contribution rules: [`UPSTREAM.md`](UPSTREAM.md).
- ⚠️ **David improved the camera's WiFi 2026-08-04 — and the camera has not dialed in since.** The
  two are almost certainly connected: this is the change that plausibly took the camera off the
  network (new SSID / band / AP / passphrase). Treat item 1 as **reopened, not done** until the
  camera is back online in the Alarm.com app.
  🔑 **This is also why the rebuild looked guilty.** Two changes landed in the same window — a WiFi
  change and a deploy — and the deploy was the one that got blamed. When two changes overlap, the
  first question is which one the evidence actually names; here the logs named neither until they
  were read, and they named the camera.
- 🆕 **Native HKSV Phase 0 is MERGED but NOT DEPLOYED.** `main` now carries the two-container split
  (`Dockerfile.go2rtc`, a two-service `docker-compose.yml`, an authenticated bridge). **The running
  image does not have any of it** — Kaikoura is still the single fused container. HKSV itself is
  **not enabled**: no `hksv:` block, no pairing. That is Phase 2.
  ✅ **Both pre-Phase-1 residuals are now FIXED** (2026-08-04, after the merge):
  1. `ADC_BRIDGE_BIND_ADDRESS` is now **required, not defaulted** —
     `${ADC_BRIDGE_BIND_ADDRESS:?...}` at both compose sites. Verified fail-closed in all three
     cases: set renders, **empty and unset both error** with the named message. This matters more
     than it looks: `local_auth: true` had removed the accident that used to catch a missing bind
     address, so go2rtc would have reported **healthy while bound where nothing can reach it**.
  2. The RTSP auth claim is corrected in `README.md`, `docs/SECURITY_AUDIT.md` and
     `config/go2rtc.example.yaml`. 🔑 **The two endpoints enforce differently and only one is
     governed by config:** `local_auth: true` covers the **API/snapshot** module including loopback,
     but **RTSP has no such setting** — `internal/rtsp/rtsp.go` skips loopback auth unconditionally
     (`&& !conn.RemoteAddr().(*net.TCPAddr).IP.IsLoopback()`), verified at the pinned commit. Every
     RTSP request still authenticates, but that comes from the **bind address**, not a toggle.
     🔴 Binding to `127.0.0.1` or `0.0.0.0` exposes unauthenticated RTSP to anything on the host.
  ✅ **All three remaining parked items are also closed** (2026-08-04): the CI timeout is 30 min
  (it now compiles go2rtc from source on top of npm ci, the suite and two image builds);
  `SECURITY_AUDIT.md`'s review date is current; and `loadConfig()` now `statSync().isFile()`-guards
  the config path, so Docker's directory-at-a-missing-bind-mount names its own cause instead of
  surfacing as a bare `EISDIR`. **Nothing is parked. Phase 0 carries no known debt.**
- **Whose turn:** **David — PHYSICAL.** The camera flaps offline in Alarm.com's own app; that is
  the root cause and no code can fix it. Chase link STABILITY, not signal strength. The bridge
  self-recovers each time the camera returns, so no restarts are needed while diagnosing.

### What's left (priority order)

1. 🔴🔴 **(David — PHYSICAL, and it is the root cause of everything else) THE CAMERA FLAPS.** It
   goes **offline in the Alarm.com app itself**, intermittently — confirmed 2026-08-04. Moving it to
   a closer AP raised signal strength but did **not** make the link stable, so stop optimising RSSI.
   Chase **stability**: pin it to one AP and one band (disable band steering), check the mesh's
   client list for it bouncing between nodes, and consider channel interference or camera power.
   ⚠️ Everything else in this list is unmeasurable until this is fixed — an intermittent camera
   makes every other test unrepeatable.
2. 🔬 **(Agent — cheap, and it gates the value of the whole make-before-break merge)** **Determine
   whether Alarm.com allows more than one e2e session per camera.** Grep any token refresh for
   `Second concurrent session refused by Alarm.com`. If ADC permits only one, the overlap can never
   hold two sessions, the fallback runs every time, and the ~1.2 s gap is *not* closed — which
   would make issue `Omar-L#25` still open in substance. Needs `docker-compose logs` (sudo).
3. **(David, then agent)** **HKSV is unblocked** — the event stream delivers for the first time.
   Needs `videoConfig.recording: true` + `prebuffer` + `motion` + `porthttp` in Homebridge, the
   bridge's `homebridge.motionUrl` pointed at it, a Homebridge restart, and recording enabled in the
   Home app. Best after item 2, since make-before-break exists precisely because HKSV recording is
   what cares about the refresh gap.
4. ✅ **(David — DONE 2026-08-04, with caveats)** `/volume1/homebridge/config.json` was **0777**
   (HomeKit pairing data) and is now **775**. World-**write** is gone, which was the worst of it.
   Two residuals, neither urgent:
   - ⚠️ **Still world-readable.** `775` is `rwxrwxr-x`, and [`INVARIANTS.md`](INVARIANTS.md) records
     this file's standard as mode **600** — so it remains looser than what is already written down.
   - ⚠️ **It may not hold.** The mode comes from the **volume's default ACL**, and the Homebridge UI
     rewrites the file on every settings change. A `chmod` gets reverted; the durable fix is at the
     shared-folder/ACL level. **Re-check after the next Homebridge settings change** — if it is back
     to 0777, the ACL is the real target and this item reopens.
5. *(Agent — now measurable, was confounded by the link)* **A/B `-reorder_queue_size 0`.** Production
   logs 2026-08-04 show ffmpeg repeatedly emitting `Non-monotonic DTS ... This may result in
   incorrect timestamps in the output file` while streaming normally. The flag disables RTP
   reordering, which is right on a clean LAN and wrong over a weak wireless link — the condition
   item 1 just addressed. ⚠️ Run it **after item 2**, on the improved link, or it measures the WiFi
   rather than the flag. Matters for HKSV, which cares about timestamp continuity.
6. *(Agent, low)* go2rtc stream auto-configuration — `config/go2rtc.yaml` is hand-synced with
   `config/config.yaml`. `src/discover.ts` already generates both blocks; the job is reconciling at
   startup, not deriving names.
7. *(Agent, low)* Audio passthrough. The peer connection negotiates Opus/PCMU/PCMA but only video is
   subscribed. ⚠️ A camera demoted to Proxy has **no audio at all**, so this only means anything on
   a Direct connection.
8. *(Agent, trivial — deferred from the make-before-break review, all triaged "ship as is")* Dead
   `'fallback'` member of `OverlapOutcome`; a false comment near `cutOver` about `activeDied`;
   `rtpCount` not reset across reconnect; a `tryConnect()` rejection in the fallback leaving
   `_state` at `'connecting'` rather than `'error'`. ⚠️ One is **not** cosmetic: `onFailed` fires on
   `'disconnected'` too, so a transient ICE blip now forces a full teardown — only observable
   against a real camera, so revisit after item 2.
9. *(Trivial)* `src/discover.ts` prints `%-20s` literally — `console.log` uses `util.format`, which
   has no printf width specifiers. Cosmetic; the generated YAML is fine.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or
  captured frames. **This applies to this file too.**
- 🔎 **Everything else that used to be listed here now lives in [`INVARIANTS.md`](INVARIANTS.md)** —
  the "no video" diagnosis order, the `endToEndWebrtcConnectionInfo: null` trap, the ~37s
  stale-callback fix, session-callback ownership, the two circuit-breaker rules, and the Homebridge
  and Synology invariants. **Search it before changing any of those.**

### Open decisions

- Whether to enable Alarm.com motion webhooks and HKSV after the live-view pilot is stable.
  ✅ The blocker (the camera's signal) was addressed 2026-08-04 — this is now a real decision rather
  than a deferred one. Sequence it after item 2 so the pilot is running the merged code.
- **Native HKSV via go2rtc** — spiked and measured; verdict is *track, adopt when it ships*, and
  adoption needs go2rtc split into its own container first. Do not re-litigate from scratch: the
  full verdict and its constraints are in [`INVARIANTS.md`](INVARIANTS.md).
