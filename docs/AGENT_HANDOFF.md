# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff.

📖 **Narrative history — the WHY — lives in [`Journal.md`](../Journal.md).** Read its most recent
entry for how the current state came about; `grep` for older ones. If it disagrees with this
baton, the baton wins.

🔎 **Three files carry what used to bloat this one. Search them; do not read them front to back.**
- [`INVARIANTS.md`](INVARIANTS.md) — what must not be undone, re-diagnosed, or "simplified".
  Read before touching reconnect/session lifecycle, the circuit breaker, or Homebridge on the NAS.
- [`UPSTREAM.md`](UPSTREAM.md) — the Omar-L PR/issue tracker and the rules for contributing there.
- [`journal/2026-08-31-baton-completed-items.md`](journal/2026-08-31-baton-completed-items.md) — the
  thirteen closed items that used to live in the list below, moved unedited on 2026-08-31.

---

## Current handoff

- **Last agent:** Claude Code (Opus 5)
- **Updated:** 2026-08-25. Architecture unchanged: cameras reach HomeKit over their **own local
  RTSP**, go2rtc's native client, in-process HKSV, **zero ffmpeg in the media path**. Motion from
  go2rtc's own detector, so Alarm.com is out of the video path entirely.
  📖 `Journal.md` 2026-08-25 for the WHY of everything below.
- 🔴 **ONLY THE ADC-V723 (front) IS STREAMING. Both ADC-V515s are OFF THE NETWORK.** Confirmed by
  David and by `EHOSTUNREACH` on a TCP connect to their configured endpoints from the NAS. **Not a
  config or code fault.** Their HKSV recording had been dead ~17 days before anything noticed.
  ➡️ When they return they should recover on their own and log it. If they come back and stay
  unhealthy, their addresses moved: `config.yaml` is stale and `discover:local` refreshes it.
- 🔴 **Do NOT write push state here. Run the command:**
  `git fetch && git log --oneline origin/main..main`. 🔑 Verify with
  `git ls-remote origin refs/heads/main`, not a local `origin/*` ref — those are only as fresh as the
  last fetch. ⚠️ This line has been wrong three times in this repo, in both directions.
  📌 What git cannot say: `origin/docs/community-onboarding` is abandoned at `65fca25`, and the local
  `agent/discover-local-write` (`df03624`) is merged and safe to delete.
- **Deployed:** go2rtc **rebuilt 2026-08-25** and running `1.9.14+dev.2464e56`; the **bridge** was
  rebuilt after it and carries the relay health check. ⚠️ Pushing does NOT deploy: the NAS checkout
  at `/volume1/docker/adc-video-bridge` is a separate clone, pulled and rebuilt BY HAND, and every
  `docker-compose` command needs David's sudo. ⚠️ Compose is v2.20.1 despite the hyphenated name.
  🔑 Rollback image for go2rtc is tagged `go2rtc-rollback-506cfa7`.
  💡 "Do I need a rebuild?" — derive it from the `COPY` lines, not a summary: `package.json`,
  `package-lock.json`, `tsconfig.json`, `src/`, `entrypoint.sh`. Match by PREFIX (`^src/`).
- 🔑 **go2rtc is built from `Mo3he/go2rtc@2464e567`, NOT skrashevich.** A different maintainer, so a
  supply-chain change, recorded in `SECURITY_AUDIT.md`. It is the old pin plus 25 commits, 0 behind,
  and it **fixes two packages that failed on the old one** (`pkg/hap/tlv8`, `pkg/hap/camera`).
  ✅ `patches/go2rtc-hap-auth-exempt.patch` is **DELETED** — the HAP auth exemption we reported on
  go2rtc#2130 is now in the pinned source. Do not re-add a patch.
  🔴 **REVERT TRIGGER unchanged:** when #2130 ships officially, delete the whole build stage and
  return to the digest-pinned `alexxit/go2rtc` image.
- **Validation:** run **2026-08-25 against `e2eb144`**: `npm run build` clean, `npx vitest run`
  **26 files / 446 tests**, `npm run audit:prod` passes with the documented GHSA-2p57-rm9w-gvfp
  exception. ⚠️ Re-run before trusting.
  🔴 **The pre-commit secret scan BLOCKS, and needs enabling once per clone:**
  `git config core.hooksPath .githooks`. Also `npm run scan:secrets`. It caught four real leaks in
  its first days, twice stopping a commit an agent was mid-way through making.
- 🔑 **THREE SUDO-FREE TOOLS, in the order you will want them:**
  ```
  ssh kaikoura 'cd /volume1/docker/adc-video-bridge && export PATH=/usr/local/bin:$PATH && \
    npm run verify:config --silent -- .'                      # config seams; 0 blocking today
  ssh kaikoura 'cd /volume1/docker/adc-video-bridge && set -a && . ./.env && set +a && \
    curl -s --user "$STATUS_USERNAME:$STATUS_PASSWORD" \
      "http://$ADC_BRIDGE_BIND_ADDRESS:9090/"'                # relays + health
  # a TCP connect to localRtsp.host:port from the NAS: EHOSTUNREACH = nothing is there
  ```
  ⚠️ `npm`, `node` and `docker` are NOT on a non-interactive ssh PATH; export `/usr/local/bin`.
  ⚠️ No `jq` on the NAS — pipe output back to the Mac.
- 🔑 **Relay health is now reported, and `healthy` means TWO things:** not churning through failed
  sessions, and not silent (`msSinceDelivery` past `stalledAfterMs`, 10 min). ⚠️ The silence half
  assumes the stream is **continuously consumed**, which `motion: detect` guarantees; set
  `stalledAfterMs: 0` for an on-demand deployment. 🔴 Counting failures ALONE was not enough and
  shipped once: a relay nobody connects to has no failures to count, and reported dead cameras as
  healthy.
- 🔴 **TRIAGE: port 9090 REFUSING means the BRIDGE is down — stop looking at relay ports.** The
  bridge can crash-loop **after** logging three healthy relay lines and a successful login.
- 🔴 **A HomeKit pairing not in `config/go2rtc.yaml` exists in MEMORY ONLY and dies on restart.** One
  duplicate YAML key anywhere disables **every** config write go2rtc makes. That is what an accessory
  stuck on **"Connecting…"** means. ([`INVARIANTS.md`](INVARIANTS.md))
- 🔴 **NEVER commit** credentials, MACs, LAN/WAN IPs, tokens, camera **names** or IDs. ⚠️ Redact with
  an **allowlist** — name what to SHOW. Denylist filters leaked twice in one session.
- 🔴 **UNRESOLVED 2026-08-31: the bullet below and item 2 disagree about the log level.** This
  bullet says `level: info` with no motion visibility; item 2 says `log: { homekit: trace }` is still
  enabled. A global `info` with a `homekit: trace` override is a valid config, so the settings can
  coexist, but the conclusions cannot. Nobody has read the file on the NAS since. Resolve it before
  acting on either: `grep -A4 "^log:" /volume1/docker/adc-video-bridge/config/go2rtc.yaml` reads
  only the log block, which is safe. ⚠️ Never print a line RANGE from that file.
- ⚠️ **`log:` is at `level: info`, so there is NO motion visibility.** `motion: ON` is a **DBG** line.
  To tune thresholds set `log: { homekit: debug }` — **not `trace`**, which floods with the
  1-in-150 `motion: status` line.
- 🔑 **go2rtc logs in UTC; local is UTC-5. 3am local = `08Z`.** A `16:05` line is 11:05 local.
- 🔑 **Upstream (Omar-L): 2 merged, 7 open PRs, 3 issues** — all mergeable, all awaiting review.
  Newest: **PR #34** (media watchdog), **issue #35** (local RTSP, offered not PR'd).
  ⚠️ Do NOT report branch state from this clone; the fork's branches get rebased elsewhere. Details
  and the rebase-verification recipe: [`UPSTREAM.md`](UPSTREAM.md).
- **Whose turn:** **DAVID.** Nothing is broken and the agent backlog is empty.
  **(1)** Bring the two ADC-V515s back onto the network. Everything else waits on that, and the
  relay will now say so rather than failing silently.
  **(2)** Check whether the `ADC_MOBILE_*` capture values still exist anywhere. Only one file
  survives in `~/Downloads` and it is not the login capture. Without them `discover:local` and
  `npm run setup` need a fresh proxied capture — which is exactly what is needed if the V515
  addresses moved while they were away.
  🔑 **The one open question with real leverage is not code:** is `Haiku` per-install or a client
  constant? Asked publicly in issue #35. If constant, the proxy-and-CA-cert step disappears and
  onboarding becomes username + password.

### What's left (priority order)

🔎 **The thirteen CLOSED items moved to
[`docs/journal/2026-08-31-baton-completed-items.md`](journal/2026-08-31-baton-completed-items.md)
on 2026-08-31**, unedited. They were 58% of this file. Numbering below is unchanged so older
cross-references still resolve. The four open items are written out in full.

**Closed. The reasoning is in the archive; these lines exist so nothing gets redone:**

- **1.** ✅ Local RTSP adopted and deployed. All three cameras reach HomeKit over their own RTSP,
  go2rtc's native client, in-process HKSV, no ffmpeg in the media path.
- **2.** ✅ Thresholds settled: front 4.0 · kitchen 4.0 · sunroom 3.5. HKSV recording proven.
  🔴 **The 08-08 "the lowered threshold caused the reconnects" reading was WITHDRAWN on 08-25.**
  The cause was the two V515s going offline. The thresholds are fine; do not re-open this.
  ⚠️ `log: { homekit: trace }` was left enabled and should drop to `debug`, never be removed:
  `motion: ON` is DBG and `motion: status` is the 1-in-150 TRC flood.
- **3.** ✅ `npm run discover:local` signs in to the mobile API and returns every camera's local
  RTSP endpoint and credentials. Onboarding still needs a one-time proxied capture of four device
  values, so it is **not** "just username and password".
- **5.** ✅ `api.local_auth: true` on disk. ⏳ Not live until go2rtc restarts.
- **6.** ✅ `scripts/scan-secrets.mjs` + `.githooks/pre-commit`, and it exits 1.
  🔑 Enable once per clone: `git config core.hooksPath .githooks`.
- **9.** ✅ Homebridge `Camera-ffmpeg` platform removed on disk. ⏳ Needs a Homebridge restart.
  🔑 `Alarmdotcom` is deliberately kept: that platform is the panel, sensors and locks.
- **11.** 🚫 MOOT: `-reorder_queue_size 0` is an ffmpeg flag and there is no ffmpeg in the
  production media path.
- **12.** ✅ `discover:local -- --write` merges into the three config files, and refuses
  `config/go2rtc.yaml` once anything is paired.
- **13.** 🚫 **CLOSED. These cameras have no audio.** Alarm.com reports all four audio capability
  flags false on all three. The missing `m=audio` line is a symptom, not the cause.
  ➡️ **Do not re-investigate.**
- **14.** ✅ ICE `'disconnected'` is debounced 8s rather than treated as terminal.
- **15.** ✅ `listenPort` is allocated, never positional.
- **16.** ✅ `npm run setup`: one command, preflight through pairing codes.
- **17.** ✅ The relay now reports a camera that stops delivering.
  🔑 **Health is churn-free AND not silent.** Counting failed sessions alone shipped once and
  reported two definitively dead cameras as healthy, because a relay nobody connects to has no
  failures to count. ⚠️ The silence half assumes the stream is continuously consumed, which
  `motion: detect` guarantees; set `stalledAfterMs: 0` for an on-demand deployment.

**Still open:**

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
