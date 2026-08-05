# Native HKSV deployment design

> 🔄 **SUPERSEDED 2026-08-04 by
> [`2026-08-04-native-hksv-implementation-design.md`](2026-08-04-native-hksv-implementation-design.md).**
> Read that one for what is being built. This document is kept because its **measured evidence** is
> the foundation — the spike numbers, the networking comparison, and the observation that go2rtc
> writes pairing keys back into its config file.
>
> ⚠️ **Two things here are now known to be wrong or stale:**
> 1. *"What changes in the bridge: only configuration … no code change."* Incorrect —
>    `index.ts:43` hardcodes `rtsp://127.0.0.1:…`, taking only the port from config.
> 2. The **motion source** recommendation of `motion: detect` was chosen *because* the ADC event
>    stream was failing at ~60 × 401/hour. That is fixed, so `motion: api` is viable again.
>
> The "Why wait" section no longer governs: David decided on 2026-08-04 to proceed via a self-build,
> pinned to a commit SHA with a documented revert trigger.

**Status:** Design only — **superseded, see above.** Was blocked on
[AlexxIT/go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) merging and shipping in an
official release (still open as of 2026-08-04).

**Context:** measured 2026-08-03 (see `Journal.md`). Native go2rtc HKSV recording does **not**
re-encode: 0.7% CPU, ~22 MB RSS, zero ffmpeg processes, muxing fMP4 fragments in-process.
The benefit is established. This document is about how to *deploy* it without losing the container
hardening `docs/SECURITY_AUDIT.md` documents.

---

## The problem this design solves

The spike ran as an **unprivileged host process**, not in a container, and that is a material part
of why it was easy. HomeKit pairing requires **mDNS advertisement on the real LAN**, and Docker's
bridge network does not forward multicast. A containerised HKSV go2rtc therefore needs one of:
`network_mode: host`, a `macvlan` network, or an mDNS reflector.

Compounding it: go2rtc is currently **fused into the bridge image** — `alexxit/go2rtc` is the
runtime base and `entrypoint.sh` starts go2rtc before Node. Putting *that* container on host
networking would drag the Alarm.com credentials onto the host network stack.

## Architecture: split into two containers

```
adc-video-bridge    bridge network, hardened, holds ADC credentials     (unchanged)
        │ RTSP push to the host LAN address
        ▼
go2rtc-hksv         host network, HomeKit-facing, no ADC credentials    (new)
        │ HAP + mDNS on the LAN
        ▼
   Apple Home
```

Splitting is the point: it scopes the host-networking compromise to a component that speaks only
LAN RTSP and HAP. That component holds **HomeKit pairing keys**, which matter — but not the alarm
account.

### Networking choice: `network_mode: host`

| option | verdict |
|---|---|
| **`network_mode: host`** | **Chosen.** What Homebridge and Scrypted both document for HomeKit. Boring and well-trodden. |
| `macvlan` | Technically nicer — own LAN IP/MAC, keeps a separate netns. Rejected: painful on Synology, host↔container needs a shim interface, and it adds an operational failure mode for marginal gain. |
| mDNS reflector | Rejected as fragile. HAP advertises the port it binds, so the advertised address and port must be exactly reachable; failure mode is a silently unpairable accessory. |

**Scope the trade precisely.** Host networking costs the network namespace and
`ADC_BRIDGE_BIND_ADDRESS` confinement. It does **not** cost `read_only`, `cap_drop: ALL`,
`no-new-privileges`, non-root, `pids_limit`, or log rotation — all of those survive and must be
kept.

## Two constraints that will bite during implementation

### 1. `read_only: true` conflicts with HKSV pairing persistence

go2rtc persists `pairings`, `device_id`, and `device_private` **back into its config file** —
observed directly during the spike when the accessory was paired. So:

- the config needs a **writable** bind mount even with a read-only root filesystem
- that file then contains **HomeKit private keys** and must be mode 600
- ⚠️ the deployment volume's default ACL is **0777** (see the baton) — creating the file is not
  enough, its mode must be set and re-verified

Same shape as `.env`: a credential file that has to be writable on a permissive volume.

### 2. Digest pinning cannot survive a self-build — pin what is underneath

`SECURITY_AUDIT.md` records by-digest base image pinning as a deliberate control. A self-built
go2rtc cannot reference an upstream digest, so pin the inputs instead:

- digest-pinned `golang` builder stage
- `ARG GO2RTC_REF=<commit-sha>` — a **commit SHA, never a branch name**
- `CGO_ENABLED=0` for a static binary
- digest-pinned runtime base that **carries ffmpeg** (the snapshot provider shells out to it)
- record the resulting image digest after build

Document the delta in `SECURITY_AUDIT.md` as an accepted risk. Do not let it become a silent loss.

## What changes in the bridge

Only configuration. The bridge publishes RTSP to `localhost:8554` today because the two share a
container; split, it publishes to the go2rtc container's address, which under host networking is
the NAS LAN address. That is `rtspBaseUrl`, already configurable — **no code change**.

## Motion source

`motion: api` requires an external trigger, which today means the ADC event WebSocket — currently
failing with ~60× 401/hour (baton item 4). Until that is fixed, prefer the HKSV branch's
`motion: detect`, which does P-frame size analysis with no decoding and needs no external events.
Revisit once the event stream works, since ADC's own motion events are more accurate than
bitrate-based detection.

## Why wait

Once #2130 merges and ships, most of this shrinks: an official digest-pinned image replaces the
whole self-build section, and only the networking split remains. Implementing now buys a
maintenance burden — tracking a moving branch — for a feature already available through the
existing Homebridge path.

## Preconditions

1. 🔴 **The camera's WiFi signal must be fixed first.** HKSV recording adds sustained load on a
   link that already failed once. See baton item 1.
2. The pilot should be stable on live view before recording is enabled.

## Open questions

- What HKSV recording costs on the **Homebridge** path — never measured, because enabling it needed
  a production config edit plus a restart interrupting unrelated accessories. Worth measuring
  before adopting native, since it sets the actual benefit margin.
- Whether `motion: detect`'s P-frame heuristic is accurate enough on a 10fps stream, whose
  GOP structure is unusual compared with the 30fps sources it was presumably tuned against.
