# Native HKSV — implementation design

**Status:** Approved for implementation 2026-08-04.

**Supersedes [`2026-08-03-native-hksv-deployment-design.md`](2026-08-03-native-hksv-deployment-design.md)**,
which was design-only and explicitly blocked on
[AlexxIT/go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) shipping. That PR is **still open**
(verified 2026-08-04). David has decided to proceed anyway via a self-build. Everything in the older
document still applies unless corrected below; its measured evidence is carried forward, not
restated.

**Why the "why wait" section no longer governs:** it argued the maintenance burden of tracking a
moving branch was not worth a feature already available through Homebridge. That was a judgement
call, and it is David's to reverse. The burden is mitigated by pinning a **commit SHA** rather than
a branch, and by a documented revert trigger (below).

---

## Decisions taken (2026-08-04)

| Question | Decision |
|---|---|
| Scope | Split **and** full native HKSV in one project, phased |
| Build | Build from source in a **digest-pinned golang stage**, source pinned by **commit SHA** |
| Networking | `network_mode: host` for go2rtc only |
| ffmpeg in go2rtc image | **Included** — the snapshot provider shells out to it |
| Cutover | Run go2rtc's accessory **alongside** Homebridge's, then remove Homebridge's |

## Corrections to the 2026-08-03 design

### 1. "No code change in the bridge" is wrong

That document states `rtspBaseUrl` is already configurable. It is not, quite:

- `config.ts` `DEFAULT_CONFIG.go2rtc.apiUrl` is `http://localhost:1984` and **is** overridable from
  `config.yaml`.
- `index.ts:43` builds `` `rtsp://127.0.0.1:${config.go2rtc.rtspPort}` `` — it takes only the
  **port** from config and **hardcodes the host**.

So a small code change is required. See "Code changes".

### 2. Motion source must be re-decided, not inherited

The older document chose `motion: detect` (P-frame size analysis) **because** `motion: api` needs the
ADC event WebSocket, which was then failing at ~60 × 401/hour. **That is fixed** — the baton records
the event stream delivering for the first time.

`motion: api` is therefore now viable and is more accurate than a bitrate heuristic, and the older
document's own open question ("is `motion: detect` accurate enough on a 10 fps stream, whose GOP
structure is unusual?") argues against `detect`.

🔴 **Open — decide before Phase 2.** Prefer `motion: api` driven by the ADC event stream; fall back
to `motion: detect` if wiring the trigger proves awkward. Do not implement both.

## Architecture

```
                    ┌──────────────────────────────────────────┐
   Alarm.com ──────▶│ adc-video-bridge      (bridge network)   │
   (credentials)    │ node + ffmpeg                            │
                    │ • holds ADC user/pass/MFA                │
                    │ • werift PeerConnection → RTP → ffmpeg   │
                    │ • NO listening ports                     │
                    └───────────────┬──────────────────────────┘
                                    │ RTSP push + API to the NAS LAN address
                    ┌───────────────▼──────────────────────────┐
   HomeKit  ◀──────▶│ go2rtc                (network_mode:host)│
   (mDNS/HAP)       │ go2rtc@hksv + ffmpeg                     │
                    │ • serves RTSP / snapshots / HKSV         │
                    │ • holds HomeKit keys, NOT ADC creds      │
                    └──────────────────────────────────────────┘
```

Both containers need ffmpeg, for unrelated reasons: the bridge spawns it to mux RTP→RTSP; go2rtc
shells out to it for snapshots. **Neither is for HKSV** — HKSV muxes fMP4 in-process with zero
ffmpeg, which is the measured finding the whole project rests on.

## Security invariants

### 🔴 The two services must not share an env file

Today one container reads one `.env` containing `ADC_USERNAME`, `ADC_PASSWORD`, `ADC_MFA_TOKEN`.
Giving both services `env_file: .env` would hand the Alarm.com credentials to the host-networked
container and **defeat the entire purpose of the split**. go2rtc receives only `GO2RTC_*` and the
HKSV pin.

### 🔴 `listen:` must be an explicit address

Under host networking, compose's `ports:` mapping is **ignored**, so
`ADC_BRIDGE_BIND_ADDRESS` confinement disappears. `go2rtc.yaml` becomes the **sole** control keeping
authenticated-but-unencrypted 1984/8554 off other interfaces. A bare `:1984` means *all interfaces*
and fails **silently** — no error, just wider exposure.

### 🔴 The go2rtc config file becomes a secret

Observed during the spike: go2rtc writes `pairings`, `device_id` and `device_private` back into its
config. Therefore:

- the config needs a **writable** bind mount despite `read_only: true` on the root filesystem
- that file holds **HomeKit private keys** → mode **600**, never committed
- ⚠️ the deployment volume's default ACL is **0777**. Creating the file is not enough — set the mode
  and **re-verify it**, because the volume ACL will not respect it by default

### 🔴 The HKSV pin must be random

`pkg/hksv` hardcodes `27041991` when unset, and that default is publicly documented. Supply a random
pin via env; never commit it.

### Hardening that must survive

`read_only`, `cap_drop: ALL`, `no-new-privileges`, non-root, `pids_limit`, tmpfs `/tmp`, log
rotation — on **both** containers. Host networking costs the network namespace and nothing else.

## Images and pinning

Two Dockerfiles.

**`Dockerfile`** (bridge) — build stage unchanged; runtime base moves from `alexxit/go2rtc` to the
same digest-pinned `node:20.19.5-alpine3.22` already used for building, plus `ffmpeg` and `curl`.
`entrypoint.sh` drops the go2rtc launch but keeps a readiness wait, now against the configured
go2rtc URL rather than `localhost`.

**`Dockerfile.go2rtc`**

```dockerfile
FROM golang:<ver>-alpine@sha256:<digest> AS build
ARG GO2RTC_REF=<commit-sha>          # commit SHA, NEVER a branch name
RUN apk add --no-cache git \
 && git clone https://github.com/skrashevich/go2rtc /src \
 && git -C /src checkout "$GO2RTC_REF"
RUN cd /src && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /go2rtc ./cmd/go2rtc

FROM alpine:3.22@sha256:<digest>
RUN apk add --no-cache ffmpeg curl && addgroup -S app && adduser -S app -G app
COPY --from=build /go2rtc /usr/local/bin/go2rtc
```

**What is pinned:** the toolchain and runtime base by digest, the source by commit SHA. This is not
bit-for-bit reproducible, but it is **source-pinned and auditable** — the diff against upstream can
be reviewed, which is what the digest pin actually bought.

**Obligations, or the pin rots:**

1. `docs/SECURITY_AUDIT.md` documents a digest-pinned `alexxit/go2rtc` runtime. That control changes
   shape and must be **rewritten as an accepted, documented delta** — not silently invalidated.
2. **Revert trigger:** when #2130 merges and ships, replace the build stage with the official
   digest-pinned image. Record this in `INVARIANTS.md` beside the standing decision, or the
   self-build outlives its justification.
3. Record which upstream go2rtc version the pinned commit is based on. The current image is
   `1.9.14`; if the fork sits elsewhere, config keys may differ.

## Code changes

Three files. All are testable **without a camera**, which matters because the camera is currently
unstable.

| File | Change |
|---|---|
| `src/config.ts` | Add a configurable go2rtc **host**, defaulting to `127.0.0.1` so local dev and the pre-split behaviour are unchanged |
| `src/index.ts:43` | `rtsp://127.0.0.1:${port}` → use the configured host |
| `entrypoint.sh` | Remove the go2rtc launch; keep a readiness wait against the configured go2rtc URL |

Tests: extend `config.test.ts` for host resolution — default, explicit override, and that the RTSP
URL and API URL agree on the host. The existing **180 tests must stay green**.

## Known gap, declared rather than papered over

The bridge currently inherits its healthcheck from go2rtc's API on `localhost`. After the split it
listens on nothing, so any healthcheck pointed at go2rtc would be testing **go2rtc, not the bridge**
— a green check proving the wrong thing. This increment **declares the gap**; a real fix (a minimal
status endpoint on the bridge) is a follow-up, deliberately out of scope.

## Rollout

Phased so **only one thing changes at a time**.

| Phase | What | Needs a camera? |
|---|---|---|
| **0** | Code changes + tests; both images build; suite green | **No** |
| **1** | Deploy the split with **HKSV not enabled** — behaviour must be identical to today | Up long enough to sample parity |
| **2** | Enable HKSV; pair alongside the Homebridge accessory | 🔴 **Stable** |
| **3** | Remove the Homebridge camera accessory and its config | 🔴 **Stable** |

**Phase 1 parity checks** (against the baseline recorded in the baton): `frame.jpeg` 84–155 KB with
distinct md5s; `401` unauthenticated; a real `rtsp` producer with the Homebridge consumer; zero
WebSocket 401s; and **`docker inspect` showing no ADC credentials in the go2rtc container's
environment**.

**Phase 2 verifications**, in order:

1. 🔴 **Pair, restart the container, confirm still paired.** If pairings do not survive a restart the
   feature is unusable — find that out *before* removing the Homebridge accessory.
2. Confirm it is not transcoding: `[hksv] flush fragment` lines with sequential `seq` and ~67 KB
   fragments, an `hksv` consumer alongside `homekit` from a single producer, and **no ffmpeg beyond
   the bridge's one**. Compare CPU/RSS against the spike's 0.7% / ~22 MB.

**Rollback** is a `git checkout <commit>` on the NAS plus a rebuild — the procedure already proven
in production on 2026-08-04. Because the phases are separate commits, the split and HKSV roll back
independently, and through Phases 1–2 the **Homebridge camera keeps working**, so HomeKit never goes
dark.

## Preconditions

1. 🔴 **The camera must be stable.** It is currently **flapping** — it goes offline in Alarm.com's own
   app intermittently. Phase 0 is unaffected. Phases 2–3 are **blocked**: HKSV verification means
   comparing measurements over time, and an intermittent camera makes every result unrepeatable.
   This is not caution — it is the specific trap that cost a full session on 2026-08-04.
2. The 2026-08-03 precondition "fix the camera's WiFi signal" was attempted (moved to a closer AP,
   better signal) and **did not deliver a stable link**. Signal strength was the wrong metric; the
   open suspect is roaming/band-steering flap.

## Open questions

- **`motion: api` vs `motion: detect`** — see Corrections §2. Decide before Phase 2.
- What HKSV recording costs on the **Homebridge** path, still never measured. It sets the actual
  benefit margin but does not change the decision's direction.
- Whether the pinned fork commit is based on go2rtc `1.9.14` or a different release, and whether any
  config keys moved as a result.
