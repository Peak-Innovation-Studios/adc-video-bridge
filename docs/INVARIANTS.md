# Invariants and hard-won gotchas

Things that must not be undone, re-diagnosed, or "simplified" — each one cost a session to learn.
`docs/SECURITY_AUDIT.md` covers the credential, network, container and dependency invariants; this
file covers the behavioural ones.

Split out of `docs/AGENT_HANDOFF.md` on 2026-08-04. It lives here because it changes only when the
**design** changes, whereas the baton is rewritten every session — mixing the two buried the three
lines that had actually moved.

**This is reference. Search it; do not read it front to back.** Reach for it before changing
reconnect/session lifecycle, the circuit breaker, or anything touching Homebridge on the Synology.

---

## Diagnosis

### 🧭 "No video" — diagnose in THIS order. Cheapest and most decisive first

A full session was spent on 2026-08-03 reaching a confident, well-evidenced, **wrong** conclusion by
starting at step 3.

1. **Can Alarm.com's own web player AND phone app stream the camera?** If neither can, stop — it is
   not our code. **If they disagree with each other, suspect the network path**, because two
   first-party clients differing cannot be explained by any server-side or protocol theory.
2. Check camera WiFi signal. Power-cycle it. Re-probe.
3. Only then read our logs.

### 🔴 `"Camera <id> has not yet dialed in"` means the CAMERA is offline. It is not our bug

Alarm.com's signaling server closes the WebSocket with code **1000** (a *normal* closure, which is
why it does not look like an error) carrying this message. It means the camera has not registered
with ADC's video service — there is nothing for us to connect to.

Correct response: **fix the camera's connectivity.** Do not debug the bridge. The retry ladder and
the circuit breaker are already handling it correctly by design — 12 signaling attempts, then the
manager's `60s → 120s → 300s → 600s` backoff, then the circuit opens at 6 failures.

⚠️ **Suspect recent WiFi work first.** Measured 2026-08-04: the camera stopped dialing in
immediately after the WiFi was "improved", while a bridge rebuild happened in the same window — the
rebuild was blamed first and was innocent. If an SSID, band, AP or passphrase changed, the camera
must be **re-provisioned onto the new network**; many of these cameras are 2.4 GHz-only and will
silently fail to join a 5 GHz or band-steered SSID.

### 🔴 "It works in the Brinks/Alarm.com app" does NOT mean the camera is dialed in for US

Measured 2026-08-04: the app streamed the camera fine while the bridge — restarted fresh, new token,
no backoff — was still refused with `"has not yet dialed in"` on every attempt.

The two are not the same request. The app is an **on-demand** client: it asks, the camera wakes for
that request, it streams, everything sleeps again. It can also fall back to Alarm.com's **proxy**
path, which does not need the camera to hold a direct registration at all. This bridge is a
**perpetual** client and needs the camera dialed in *continuously*, including when nobody is
watching — a property the app never exercises and therefore never demonstrates.

So the app is still the right **step 1** (it separates "camera totally dead" from "something else"),
but a passing app check does **not** clear the camera. Only the bridge reaching `sessionStarted`
does.

### 🔴 `probe.js` returning a Direct config does NOT prove the camera is online

This cost **three** wrong conclusions in one session (2026-08-04). `probe.js` logged in, enumerated
both video sources, reported `errorEnum: 0` and a **non-null `endToEndWebrtcConnectionInfo`** —
continuously, while not a single session could be established.

Alarm.com serves that config **from its database**, not from the device. So `probe.js` proves only
that *our credentials and the ADC config API work*. It says nothing about whether a session can
actually be set up. Only the bridge reaching **`sessionStarted`** proves that.

⚠️ **The same trap has three faces. All were raised and retracted in that one session:**

| Read as… | Actually |
|---|---|
| `janusGatewayUrl` / `proxyStreamTimeoutTime` present ⇒ "demoted to Proxy" | Those fields are in the payload **always**, as fallback config |
| Signaling says "not dialed in" ⇒ "camera is offline" | It streamed in the app the whole time |
| `172.20.14.x` in the payload ⇒ "camera moved to another subnet" | `coturnAddressesTuplets` — **Alarm.com's own TURN servers** |

🔑 **The single underlying error: reading a field of ADC's payload as a statement about the camera,
when it is a statement about ADC's own plumbing.** Before concluding anything about the camera from
this payload, ask which component the field actually describes.

### 🔑 `endToEndWebrtcConnectionInfo: null` does NOT mean Alarm.com dropped end-to-end WebRTC

Proxy is their documented **failure fallback** (3-min timeout, no audio), so that `null` means
*"Direct has been failing for this camera"* — it clears when connectivity is fixed.

⚠️ **Do not build the Janus proxy path in response to this symptom.** Full reasoning, sources, and
why upstream `Omar-L#2`'s "older camera models" framing is incomplete: `Journal.md` 2026-08-03.

### Do not re-diagnose "stream dies after ~37s"

Fixed. A stale FFmpeg `exit` callback cleared the **replacement** child's reference. Two halves must
both survive any refactor — `stop()` detaches ownership *before* `SIGTERM`, and the `exit` handler
ignores the event unless the exiting child is still the owned child. Two regression tests cover it.

---

## Session lifecycle

### 🔑 Every session callback must be gated on ownership

`camera-stream.ts` has now produced the same object-lifecycle bug **three times**: the stale ffmpeg
`exit` callback, the placeholder track, and a discarded `pending` whose late RTP re-entered
`cutOver` and forced a dead pipeline back to `'streaming'`.

Any new callback on a `PeerSession` asks *"is the object that fired this still the one I own?"*
first — see the identity gate on RTP forwarding and on `onTrackReady`.

---

## Circuit breaker

### 🔑 Do not "simplify" it to count exceptions

Its failure predicate is **"produced no usable result"**, not "threw". `token-manager.ts` records a
failure on the branch where Alarm.com returns HTTP 200 with no WebRTC block, which does **not**
throw and does **not** emit `error`. That branch is the entire point; a breaker keyed on `catch`
sleeps through the outage it was built for. Reasoning: `Journal.md` 2026-08-03 and 2026-08-04.

### 🔑 The credit in `camera-manager.ts`'s reconnect branch needs BOTH conditions

Do not collapse it to one. It requires that we **still own the start guard**
(`activeStarts.get(id) === startId`) **and** that the stream is **not dead** (`'streaming'` **or**
`'connecting'`). Neither implies the other:

- **Ownership** stops a *stale* attempt crediting after a newer one took over.
- **Liveness** stops an attempt that still owns the guard crediting a stream that died in flight.

`'connecting'` counts as alive **deliberately** — the `activeDied` fallback awaits `tryConnect()`,
which resolves on `'sessionStarted'` while `onTrackReady` has not yet flipped `_state` to
`'streaming'`. Requiring `'streaming'` records neither success nor failure on a real recovery.

⚠️ A review parked this as a "known one-line fix" (swap state for ownership). **That swap is wrong
and regresses `'does not credit a torn-down stream when reconnect() resolves after it'`.** Reasoning:
`Journal.md` 2026-08-04 (later).

### ⚠️ Thresholds are coupled to the ladders next to them, and one is deliberately off by one

`STREAM_FAILURE_THRESHOLD` is `BACKOFF_STEPS_MS.length + 1` so the ladder's 10-minute cap is used
once before the circuit opens; setting it equal to the length makes that rung dead code.

`TokenManager`'s 600 s `setInterval` must stay **unconditional** — it is the backstop that restarts
the camera recovery chain after a suppressed fetch, and gating it on circuit state would make an
open token circuit permanent.

---

## Deployment and Homebridge

- The documented npm audit exception is limited to **GHSA-2p57-rm9w-gvfp** and is guarded by a check
  that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the **maintained scoped** camera package, not the stale unscoped npm package.
- Use the normal Homebridge UI login to install the plugin. **Do not mint or reuse internal UI
  tokens** to bypass authentication.
- Ports **8554** and **1984** are authenticated but unencrypted on the LAN; bind only to the
  intended host address and do not forward them.
- Homebridge `config.json` is mode 600, with a pre-camera mode-600 backup at
  `config.json.bak-adc-camera-20260801-191305`.
- If Synology reports package start failure while the Homebridge user manager has no D-Bus socket:
  verify Homebridge itself in a bounded foreground run, then recreate only that stale session with
  `sudo loginctl terminate-user homebridge` before starting the package normally.

---

## 🔴 BLOCKER: go2rtc API auth and HomeKit pairing are mutually exclusive

**Measured 2026-08-04 on the deployed fork (`1.9.14+dev.506cfa7`).** Pairing fails; the Home app
retries for ~a minute and gives up.

The HAP accessory is served on the **API port** — `internal/homekit/homekit.go` passes
`Port: uint16(api.Port)` — and `internal/api/api.go`'s `middlewareAuth` has **no path exemption**.
So HomeKit's pairing requests hit Basic auth and are rejected:

```
POST /pair-setup   -> 401
POST /pair-verify  -> 401
POST /accessories  -> 401
```

HomeKit speaks HAP, not HTTP Basic, and cannot authenticate. **With go2rtc API auth enabled at all,
native HomeKit pairing cannot work.** ⚠️ `local_auth` is NOT the deciding factor — an iPhone is
never on loopback, so the LAN path is blocked either way.

✅ **FIXED LOCALLY 2026-08-04 by `patches/go2rtc-hap-auth-exempt.patch`**, applied in
`Dockerfile.go2rtc` on top of the pinned commit. It exempts **only** `/pair-setup` and
`/pair-verify` from the Basic-auth middleware — neither is left unprotected (pair-setup is guarded
by the setup PIN via SRP, pair-verify by the long-term keys), and everything afterwards runs inside
the encrypted HAP connection `pkg/hksv` hijacks from the `ResponseWriter`, so it never re-enters
that mux. Verified: applies cleanly to a fresh checkout at `506cfa7d` and `go build ./...` is clean.
⚠️ The build uses plain `git apply` — **not** `-3` or `--reject` — so a patch that stops applying
FAILS the build loudly instead of silently producing an unpatched binary. That is the whole point of
pinning. 🔴 Report this upstream on #2130 and delete the patch when it lands there.

**Do not "fix" this by disabling go2rtc's API auth.** That would leave the snapshot/stream API
unauthenticated to every device on the LAN — for a security camera — and it breaks the compose
healthcheck, which asserts a 401. The options are: patch the fork so HAP paths bypass the auth
middleware (this looks like a real defect in PR #2130 and is worth reporting there); run a second,
auth-less go2rtc dedicated to HomeKit; or keep Homebridge serving HomeKit.

✅ **One risk retired while diagnosing:** `Store: &go2rtcPairingStore{}` **is** wired in the fork, so
the spec's "pairings may be lost on every restart" concern does not apply. go2rtc also writes
`device_id` and `device_private` back into `go2rtc.yaml` as designed — observed directly.

🔑 **Config schema correction:** the key is `homekit:` keyed by stream name with `hksv: true` nested
under it — **not** a top-level `hksv:` block as earlier docs said. Go's YAML ignores unknown keys, so
the wrong spelling starts cleanly and advertises nothing, which looks exactly like "HomeKit shows no
accessory to pair."

## 🔴 `srtp.listen` must NOT be empty once `homekit:` is configured

**Measured 2026-08-04.** The accessory pairs successfully and looks entirely healthy, then shows
**"No Response"** in the Home app and never sends video.

`internal/srtp` returns early when `listen` is empty, leaving `srtp.Server` **nil**, and
`internal/homekit`'s `streamHandler` refuses every stream with `homekit: can't work without SRTP
server`. Nothing in the Home app hints at the cause. Set it to a bound address —
`"${GO2RTC_BIND}:8443"` (`:8443` is the module's own default) — never `""`.

⚠️ This was flagged during the Phase 0 final review as a "Phase-2 landmine", recorded only in the
SDD ledger, and **lost when that gitignored worktree was deleted at merge**. It then cost a real
debugging cycle. 🔑 **A finding that lives only in scratch state does not survive the merge that
ends the work — move it into the repo before deleting the workspace.**

## Standing decision: native HKSV via go2rtc

**Spiked and measured 2026-08-03. Verdict: track, adopt when it ships.** Recorded here so it is not
re-litigated from scratch.

HKSV **recording does not re-encode**: 0.7% CPU, ~22 MB RSS, **zero ffmpeg**, muxing fMP4
in-process.

⚠️ Do **not** repeat the earlier argument that `vcodec: "copy"` makes this pointless — `vcodec`
governs *live view*, not HKSV recording. Costs are unchanged
([go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is unmerged and unreleased → self-build,
losing the by-digest pin), but the benefit is now established rather than speculative.

🔴 **Adoption is not a swap — the spike ran on the HOST, not in Docker, which is why it was easy.**
HomeKit needs mDNS on the real LAN and Docker bridge networking does not forward multicast, so a
containerised HKSV go2rtc needs `network_mode: host`, `macvlan`, or an mDNS reflector. Host
networking costs **only** the network-namespace control — read-only rootfs, `cap_drop: ALL`,
`no-new-privileges`, non-root and digest pinning all survive it.

✅ **Prerequisite done (Phase 0, 2026-08-04): go2rtc is split into its own container.** It was
previously fused into the bridge image (`alexxit/go2rtc` as the runtime base, started by
`entrypoint.sh`), which would have put the ADC-credential-holding bridge on host networking too.
Now only the go2rtc container runs `network_mode: host`; the bridge keeps its own network namespace
on the default Docker network and holds the Alarm.com credentials there. HKSV itself is still **not
enabled** — no `hksv:` block, `srtp:` still disabled.

🔴 **Revert trigger: when go2rtc#2130 merges and ships in an official release, delete the build
stage in `Dockerfile.go2rtc` and go back to the official digest-pinned `alexxit/go2rtc` image.** The
self-build (toolchain pinned by digest, source pinned to a commit SHA on the `hksv` branch — see
`docs/SECURITY_AUDIT.md`) is justified only by HKSV being unreleased. Without deleting the stage
when the PR ships, the self-build outlives its justification and keeps carrying a maintenance and
audit cost the official image no longer requires.

Spike method, gotchas, and what stayed unmeasured: `Journal.md` 2026-08-03.
🧹 Spike fully torn down; production untouched. Delete any leftover **"HKSV Spike"** accessory from
the Home app.
