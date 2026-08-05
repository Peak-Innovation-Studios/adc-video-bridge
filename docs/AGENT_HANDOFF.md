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
- **Updated:** 2026-08-04 (later) — **merged `make-before-break` into `main`** (12 commits), closing
  the ~1.2s media gap; then split this baton into the two files above. Narrative: `Journal.md`,
  entry "2026-08-04 (later)".
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
  `npm run build` clean, `npx vitest run` **12 files / 180 tests**, `npm run audit:prod` passed with
  the documented GHSA-2p57-rm9w-gvfp exception.
  ✅ **Agent worktrees no longer double-count the suite.** They live under `.claude/worktrees/`
  *inside* the repo, so their copy of `src/` used to match vitest's include glob and every run
  counted twice (12/180 → 24/360). `vitest.config.ts` now excludes `**/.claude/**`. ⚠️ If you ever
  edit that `exclude`, **spread `defaultExclude`** — setting it replaces the defaults, and in
  vitest 4 those are only `node_modules` and `.git`.
- 🔴🔴 **PRODUCTION IS NOT STREAMING.** Kaikoura was rebuilt onto make-before-break 2026-08-04
  (**image built from `34f1338`**, previous image `2e98710`) and video stopped. Every signaling
  attempt is closed by Alarm.com with `"Camera <id> has not yet dialed in"` (WebSocket code **1000**,
  a *normal* close, which is why it does not look like an error).
  **Measured sudo-free:** `frame.jpeg` **0 bytes** (was 84–127 KB) · go2rtc `bytes_recv` **0**, flat ·
  producers/receivers **1 / 0** · **no `ffmpeg`** · ports 8554/1984 accepting · unauthenticated
  `frame.jpeg` still **401**. So go2rtc and auth are fine; nothing reaches them.
  The bridge itself behaves exactly as designed — 12 signaling attempts, then the manager's
  `60 → 120 → 300 → 600 s` ladder, breaker opening at 6 failures.
  ✅ **THE CAMERA IS CLEARED — do not re-investigate it.** It streams perfectly in the Brinks app,
  sits on a **closer AP with better signal** than before, and its **IP is unchanged** (no subnet,
  VLAN or band change). Were it off the network the app could not stream it either.
  **Ruled out — do not repeat:**
  | Tried | Result |
  |---|---|
  | Camera power-cycle | no change |
  | `docker-compose restart` ×2 (resets backoff → immediate attempt) | refused instantly |
  | Fresh token every attempt | same refusal |
  | Waiting out the backoff ladder | same refusal |
  🎯 **THE DECISIVE TEST — roll back the image.** The camera is cleared, so the rebuild is the only
  uncontrolled variable. `main` is untouched; this is a checkout on the NAS.
  ```
  cd /volume1/docker/adc-video-bridge && git checkout 2e98710 && \
    sudo /var/packages/ContainerManager/target/usr/bin/docker-compose up -d --build adc-video-bridge
  ```
  - **Video returns** ⇒ make-before-break broke the **initial connect** path — notably the half the
    180 tests cover *least*, since they overwhelmingly exercise reconnect. Restore with
    `git checkout main` + rebuild, then fix properly. Prime suspects: the new `onTrackReady`
    ownership gate and the RTP session-identity gate, both of which **drop silently** rather than
    error.
  - **Still refused** ⇒ the code is genuinely exonerated; this is Alarm.com account/service-side and
    becomes a support call.
  ⚠️ **THREE WRONG THEORIES WERE RAISED AND RETRACTED THIS SESSION. Do not re-derive them:**
  1. *"Alarm.com demoted the camera to Proxy."* No — `janusGatewayUrl`/`proxyStreamTimeoutTime` are
     in the payload **always**, as fallback config. Demotion is specifically
     `endToEndWebrtcConnectionInfo: null`, and it never was.
  2. *"The camera is offline."* No — it streams in the app.
  3. *"The camera is on a different subnet."* No — the `172.20.14.x` addresses are
     `coturnAddressesTuplets`, **Alarm.com's own TURN infrastructure**.
  🔑 **All three were the same error: reading a field of ADC's payload as a statement about the
  camera, when it was a statement about ADC's own plumbing.** `probe.js` answers from Alarm.com's
  **database** — it reported `errorEnum: 0`, non-null `endToEndWebrtcConnectionInfo` and both video
  sources throughout, while no session could be established. **It cannot prove the camera can
  stream.** Only the bridge reaching `sessionStarted` proves that. See [`INVARIANTS.md`](INVARIANTS.md).
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
- **Whose turn:** **David — PHYSICAL.** Production is down because **the camera is not dialed in to
  Alarm.com** (diagnosed from logs — not our code, do not roll back). Re-provision it onto the
  changed WiFi, checking the 2.4 GHz band. The bridge self-recovers once it returns. Everything below
  item 2 is parked, including the agent work the WiFi fix had just unblocked.

### What's left (priority order)

1. ⚠️ **(David — REOPENED 2026-08-04)** **The WiFi was improved, and the camera then stopped dialing
   in to Alarm.com.** Superseded by item 2, which is the live version of this. Original context: This is what caused the
   2026-08-03 outage and gated every item below. ⚠️ **Still unverified under load** — re-probe and
   watch for `Circuit OPEN` before treating the link as solved, since a perpetual session stresses
   it far harder than Alarm.com's own on-demand clients. If the outage recurs, the cause was not
   fully addressed: a power-cycle clears the symptom, not the cause, and the durable fixes are wired
   Ethernet, relocation, or an added AP.
2. 🔴🔴 **(David — PHYSICAL. Get the camera back on WiFi; nothing else matters until it dials in.)**
   **Diagnosed:** Alarm.com's signaling server reports the camera **has not dialed in**. Not a code
   problem, and no agent can fix it. 🔴 **Do NOT roll back** — the new image is exonerated and a
   rollback would only lose the ~1.2 s-gap fix. In order:
   1. **Does the camera show online in the Alarm.com app?** If it is offline there, it is offline
      full stop; everything else is downstream of that.
   2. **Re-provision it onto the changed network.** ⚠️ Check the **band** — many of these cameras
      are 2.4 GHz-only and silently fail to join a 5 GHz or band-steered SSID. A changed SSID or
      passphrase is not something the camera learns by itself.
   3. **Power-cycle**, then re-check the app.
   💡 **Nothing to redeploy afterwards.** The bridge recovers on its own: `TokenManager`'s 600 s
   interval is unconditional and is the backstop that restarts the chain, and the breaker self-heals
   on its first successful probe. Expect recovery within ~15 minutes of the camera returning.
   💡 Once video is back, grep for `Second concurrent session refused by Alarm.com` — how production
   tells us whether ADC permits two sessions per camera at all, which the whole overlap rests on.
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
