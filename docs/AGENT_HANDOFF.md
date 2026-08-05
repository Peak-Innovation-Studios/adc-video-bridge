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
- **Working tree:** Run `git status --short`. No agent has uncommitted work. The
  `make-before-break` worktree and branch are **merged and deleted** — `git worktree list` should
  show only the main checkout.
- **Validation (as of the commit this baton describes — re-run before trusting it):**
  `npm run build` clean, `npx vitest run` **12 files / 180 tests**, `npm run audit:prod` passed with
  the documented GHSA-2p57-rm9w-gvfp exception.
  ⚠️ **If you see ~360 tests, an agent worktree is back under `.claude/worktrees/`.**
  `vitest.config.ts` sets no `include`/`exclude`, so the default glob walks the worktree's copy of
  `src/` too. Cosmetic when both copies pass — but a **stale** worktree's failures will fail
  `main`'s suite while pointing at files that look like the ones you are editing.
- 🔴 **Kaikoura does NOT have make-before-break yet.** It is still running the circuit-breaker build
  David rebuilt 2026-08-04. `src/` changed, so it needs `docker-compose up -d --build`. ⚠️ Not
  before item 1 — deploying onto a camera with a bad link measures the WiFi, not the change.
- **What Kaikoura IS running is live, streaming and healthy** — verified sudo-free (go2rtc answers
  `401` on its bound address; distinct-md5 JPEGs; a real `rtsp+tcp` publisher; **0** WebSocket 401s,
  was ~60/hour). Motion, doorbell, audio and HKSV remain disabled.
  ⚠️ **Still unverified: whether the breaker has actually opened or probed in anger.** Needs
  `docker-compose logs` (sudo) — grep `Circuit OPEN`, `probing`, `Circuit closed`. Until the
  camera's WiFi is fixed, expect it to open.
- **Sudo-free diagnosis on Kaikoura:** `node dist/probe.js <cameraId>` and `node dist/discover.js`
  work from the checkout after `set -a; . ./.env; set +a`. Use these instead of `docker exec`, which
  needs David's password. `node_modules`/`dist` there are gitignored.
- **⬆️ Eight upstream PRs and two issues are open at Omar-L, all awaiting his review.** Nothing is
  blocked on us. Table, held branches, and the contribution rules: [`UPSTREAM.md`](UPSTREAM.md).
- **Whose turn:** **David** — the camera's WiFi (item 1) is the only thing no code can fix, and it
  gates everything else including the deploy of the work just merged. ⚠️ **The agent queue is now
  genuinely blocked on it**: every remaining code item either measures that link or is invalidated
  by it. There is no longer useful agent work that routes around item 1.

### What's left (priority order)

1. 🔴 **(David — physical, gates everything)** **The camera's WiFi signal is poor.** It caused the
   2026-08-03 outage and will again; a power-cycle clears the symptom, not the cause. Wired Ethernet
   if the camera supports it, else relocate it or add an AP. Matters more here than for normal use:
   Alarm.com designs for *on-demand* viewing, this bridge holds a **perpetual** session.
2. **(David — 1 min)** `/volume1/homebridge/config.json` is mode **0777** (HomeKit pairing data).
   ⚠️ `chmod` alone will not hold: it is the **volume's default ACL**, and the Homebridge UI rewrites
   the file on every settings change. Durable fix is at the shared-folder/ACL level.
3. **(David — deploy)** **Rebuild Kaikoura to pick up make-before-break.** `docker-compose up -d
   --build`, since `src/` changed. Then confirm the gap is gone — the old signature is a ~1.2s media
   stall every 600s at token refresh. ⚠️ Not before item 1: on a weak link the overlap can fail and
   fall back to break-before-make, which measures the WiFi rather than the change.
   💡 Grep the logs for `Second concurrent session refused by Alarm.com` — that line is how
   production tells us whether ADC permits two sessions per camera at all, which is the assumption
   the whole overlap rests on.
4. **(David, then agent)** **HKSV is unblocked** — the event stream delivers for the first time.
   Needs `videoConfig.recording: true` + `prebuffer` + `motion` + `porthttp` in Homebridge, the
   bridge's `homebridge.motionUrl` pointed at it, a Homebridge restart, and recording enabled in the
   Home app. ⚠️ Not before item 1; best after item 3, since make-before-break exists precisely
   because HKSV recording is what cares about the refresh gap.
5. *(Agent, low)* **A/B `-reorder_queue_size 0`** — no longer speculative. Production logs
   2026-08-04 show ffmpeg repeatedly emitting `Non-monotonic DTS ... This may result in incorrect
   timestamps in the output file` while streaming normally. The
   flag disables RTP reordering, which is right on a clean LAN and wrong over a weak wireless link —
   exactly the condition item 1 describes. ⚠️ Test **after** item 1, or it measures the WiFi rather
   than the flag. Matters for HKSV, which cares about timestamp continuity.
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
   against a real camera, so revisit after item 3.
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
  ⚠️ Not until the camera's signal problem is addressed — see item 1.
- **Native HKSV via go2rtc** — spiked and measured; verdict is *track, adopt when it ships*, and
  adoption needs go2rtc split into its own container first. Do not re-litigate from scratch: the
  full verdict and its constraints are in [`INVARIANTS.md`](INVARIANTS.md).
