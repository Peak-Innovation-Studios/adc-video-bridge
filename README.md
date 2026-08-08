# adc-video-bridge

Bridges Alarm.com security camera streams to local RTSP for HomeKit Secure Video (HKSV) via Homebridge.

This repository is the Peak Innovation Studios maintained fork of
[`Omar-L/adc-video-bridge`](https://github.com/Omar-L/adc-video-bridge). It
preserves the upstream history while carrying tested container hardening,
Synology deployment guidance, and stream-lifecycle fixes. Portable fixes can
still be proposed upstream without mixing this project with the separate
Alarm.com Homebridge plugin.

## Two ways in, and the good one is local

Alarm.com cameras serve **their own RTSP stream on your LAN**, tunnelled over HTTPS. This
bridge can reach it directly — no cloud, no video tokens, no WebRTC — and republish it to
HomeKit through [go2rtc](https://github.com/AlexxIT/go2rtc), with **H.264 passthrough and no
ffmpeg in the media path**.

| | **Local RTSP** (recommended) | WebRTC (original, legacy) |
|---|---|---|
| Path | camera → your LAN → go2rtc → HomeKit | camera → Alarm.com cloud → WebRTC → ffmpeg → go2rtc |
| Cloud dependency | none for video | signalling, tokens refreshed every 10 min |
| ffmpeg | none | one process per camera |
| ADC-V515 cameras | ✅ works | 🔴 **impossible** — they report `SupportsWebRTC: false` |
| Setup | needs per-camera endpoint + credentials | needs camera IDs |

🔑 **If your cameras are ADC-V515 (or any model reporting `SupportsWebRTC: false`), local
RTSP is the only path that will ever work.** No amount of fixing on Alarm.com's side changes
that.

⚠️ **The catch, and it is a real one:** the per-camera RTSP endpoints and credentials are
published only by Alarm.com's **mobile** API, which this project cannot yet call. Today you
extract them by proxying the phone app. Closing that gap is the highest-value work
outstanding — see [`docs/MOBILE_API.md`](docs/MOBILE_API.md).

### Historical note

The original premise of this project was that Alarm.com cameras *cannot* be reached over
RTSP, because ADC re-provisions camera credentials over OpenVPN with randomised root
passwords. That is true of the **web** API this project was ported from, and false of the
platform: the mobile API hands out working local RTSP endpoints, and Alarm.com's own app
streams `connectionType: DIRECT, protocolType: RTSP`. Corrected 2026-08-07 —
see [`docs/INVARIANTS.md`](docs/INVARIANTS.md) and `Journal.md`.

The existing [homebridge-node-alarm-dot-com](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com)
plugin handles alarm panel, sensors and locks, but has no video support.

## Architecture

Two containers: the bridge holds the Alarm.com credentials and stays on the
default Docker bridge network; go2rtc runs on `network_mode: host` because
HomeKit needs mDNS multicast, which bridge networking does not forward. They
address each other over the host's LAN address (`ADC_BRIDGE_BIND_ADDRESS`),
never `localhost`.

### Local RTSP — the recommended path

The camera serves RTSP tunnelled over HTTPS. `TunnelRelay` presents that as ordinary RTSP on
a published port, and go2rtc pulls it with its **native** client — H.264 passthrough
straight into in-process HKSV muxing, **no ffmpeg process at all**.

```
   camera (your LAN)
        │  RTSP tunnelled over HTTPS
        ▼
┌──────────────────────────────────┐
│  adc-video-bridge container      │
│                                  │
│  [TunnelRelay] × N ──────────────┼──── plain RTSP on :8561+
│   HTTPS tunnel → plain RTSP      │        │
│   (holds NO camera credentials)  │        │
│                                  │        │
│  [StatusServer]  /  → JSON       │        │
│                  /pair → QR codes│        │
└──────────────────────────────────┘        │
                                            ▼
                              ┌───────────────────────────┐
                              │ go2rtc (network_mode host)│
                              │  native RTSP client       │
                              │  native HKSV muxing       │
                              │  HAP + SRTP → Apple Home  │
                              └───────────────────────────┘
```

🔑 The relay is a **byte relay**: the camera's own Digest challenge passes through it
untouched, so go2rtc authenticates end to end and the camera credentials live in
`config/go2rtc.yaml`, never in the container holding the Alarm.com login.

### WebRTC — the original path, still supported

Used for any camera without a `localRtsp` block. Requires Alarm.com's cloud for signalling
and a video token refreshed every 10 minutes, and terminates WebRTC server-side with
[werift](https://github.com/nicknisi/werift-webrtc) before piping through ffmpeg to go2rtc.

```
[AlarmAuth] → [TokenManager] → [CameraManager] → [CameraStream] × N
                                                   │         │
                                      [ADC Signaling WS]  [werift PC]
                                                             │ RTP
                                                        [ffmpeg] → RTSP push → go2rtc
```

⚠️ A camera configured with `localRtsp` is **excluded** from this path — both publish into
the same go2rtc stream name, and running both interleaves rather than erroring.

### Motion

Motion drives HKSV recording, and go2rtc can source it three ways
(`motion:` under each `homekit:` entry):

| mode | trigger | dependency |
|---|---|---|
| `detect` | go2rtc analyses H.264 P-frame sizes itself | **none** |
| `api` | the bridge POSTs Alarm.com events to go2rtc | an Alarm.com **notification rule** |
| `continuous` | always recording | none |

🔴 **`motion: api` fails silently without a rule.** Everything looks healthy — paired
accessory, live view, connected event socket — and HKSV simply never records. `npm run
verify:config` warns about this. `detect` needs a per-scene `motion_threshold`; a dim room
generates enough sensor noise to trigger the default.

## How the signaling works

The ADC end-to-end WebRTC signaling protocol (ported from the HA integration's `alarm-webrtc-card.js`):

1. Fetch video token: `GET /web/api/video/videoSources/liveVideoHighestResSources/<cameraId>`
2. Extract `endToEndWebrtcConnectionInfo` from response (signalling URL, JWT token, camera auth token, ICE servers)
3. Connect WebSocket to `${signallingServerUrl}/${signallingServerToken}`
4. Send `HELLO 2.0.1` → receive `HELLO`
5. Send `START_SESSION <cameraAuthToken>` → receive `SESSION_STARTED`
6. Receive SDP offer (JSON) → create answer with werift → send answer back
7. Exchange ICE candidates
8. WebRTC media flows (H.264 1080p @ 10fps)

### Key discovery: camera wake timing

The `liveVideoHighestResSources` API call triggers the camera to wake up and dial in to the signaling server. The camera takes a few seconds to connect, so:
- First attempt usually fails with "Camera has not yet dialed in"
- Retry with a fresh token after 15 seconds — the camera is now awake
- Subsequent retries use 10-second intervals

The bridge refreshes video tokens every 10 minutes and rebuilds the token-bound WebRTC connection while keeping the RTSP publisher alive. ADC telemetry confirms there is no server-enforced session timeout; the refresh interval is set conservatively to keep signaling credentials fresh.

## Current status

**Working — local RTSP path:**
- Camera RTSP over its own HTTPS tunnel (`src/rtsp/tunnel-relay.ts`), no cloud and no video token
- go2rtc pulls it with its native client — **no ffmpeg in the media path**
- Works on ADC-V515 cameras, which WebRTC can never serve
- Native HomeKit via go2rtc: live view, HKSV recording, in-process fMP4 muxing
- Built-in motion detection (`motion: detect`) with per-camera thresholds — no Alarm.com dependency
- Scannable pairing codes served at `GET /pair` on the status endpoint
- Cross-file config checking (`npm run verify:config`) and printable labels (`npm run homekit:label`)

**Working — WebRTC path (original):**
- Alarm.com authentication via `node-alarm-dot-com`, camera discovery CLI
- Video token fetching and refresh, end-to-end signalling, werift termination, ffmpeg → go2rtc
- Camera dial-in retry with exponential backoff, circuit breakers on all three retry loops
- Real-time motion via the ADC WebSocket event stream, forwarded to go2rtc and/or Homebridge

**Shared:**
- Hardened containers: the credential-holding bridge and go2rtc are separate images in separate
  network namespaces, non-root, read-only rootfs, capabilities dropped
- Read-only status endpoint with relay, camera and event-listener diagnostics

**Not yet done:**
- 🔴 **Fetching local RTSP endpoints automatically** — they live on Alarm.com's mobile API, which
  this project cannot yet call, so they are configured by hand. This is the main barrier to adoption:
  [`docs/MOBILE_API.md`](docs/MOBILE_API.md)
- go2rtc stream auto-configuration (currently manual in `config/go2rtc.yaml`)
- Audio — the local RTSP stream carries no audio track at all

## Project structure

```
src/
├── index.ts                  # Entry point, graceful shutdown
├── config.ts                 # YAML config loader
├── types.ts                  # Shared interfaces
├── discover.ts               # Camera discovery CLI
├── auth/
│   ├── alarm-auth.ts         # Wraps node-alarm-dot-com login + camera discovery
│   └── token-manager.ts      # Session refresh (55min) + video token refresh (10min/camera)
├── signaling/
│   └── signaling-client.ts   # WebSocket: HELLO, START_SESSION, SDP/ICE relay
├── camera/
│   ├── camera-stream.ts      # Per-camera: signaling → werift → RTP → ffmpeg → RTSP
│   └── camera-manager.ts     # Multi-camera orchestration with backoff
├── events/
│   ├── alarm-event-listener.ts  # ADC WebSocket event stream with proactive refresh
│   ├── parse-event.ts        # Event parsing (motion, sensor, clip events)
│   └── types.ts              # Event type definitions
├── go2rtc/
│   └── go2rtc-api.ts         # go2rtc REST API: health, motion, HomeKit accessories
├── homekit/
│   ├── qr.ts                 # QR encoder (byte mode, single-block versions)
│   ├── setup-uri.ts          # X-HM:// setup payloads, derived as go2rtc derives them
│   └── label.ts              # printable pairing labels
├── rtsp/
│   └── tunnel-relay.ts       # RTSP-over-HTTPS tunnel → plain RTSP, one listener per camera
└── utils/
    ├── circuit-breaker.ts    # Pauses a retry loop that is getting nowhere
    ├── logger.ts             # pino structured logging
    ├── retry.ts              # Exponential backoff helper
    └── sdp.ts                # H.264 fmtp extraction from SDP offers
```

## Setup

See the **[Setup Guide](docs/SETUP.md)** for the full end-to-end instructions.
For Synology Container Manager, use the dedicated
**[Synology Deployment Guide](docs/SYNOLOGY.md)**, including its safe update and
rebuild procedure.

**Quick start:**

```bash
git clone https://github.com/Peak-Innovation-Studios/adc-video-bridge.git
cd adc-video-bridge
cp .env.example .env
cp config/config.example.yaml config/config.yaml
cp config/go2rtc.example.yaml config/go2rtc.yaml
# Put credentials and random go2rtc passwords in .env; put camera IDs in config.yaml.
chmod 600 .env config/config.yaml config/go2rtc.yaml
docker compose -f docker-compose.yml up --build -d
```

Pulling source changes does not update an already-built container. After every
code update, rebuild with `docker compose up -d --build`. Configuration-only
changes can use `docker compose restart`.

## Environment variables

Credentials should be provided through environment variables or Docker secret files. Environment values take precedence over legacy credentials in `config.yaml`.

| Variable | Description | Required |
|----------|-------------|----------|
| `ADC_USERNAME` | Alarm.com account email | Yes |
| `ADC_PASSWORD` | Alarm.com account password | Yes |
| `ADC_MFA_TOKEN` | Two-factor authentication token (from trusted device setup) | No |
| `ADC_USERNAME_FILE` | File containing the Alarm.com username | Alternative to `ADC_USERNAME` |
| `ADC_PASSWORD_FILE` | File containing the Alarm.com password | Alternative to `ADC_PASSWORD` |
| `ADC_MFA_TOKEN_FILE` | File containing the optional MFA token | No |
| `GO2RTC_API_USERNAME` | Username protecting snapshots and the go2rtc API | Docker: yes |
| `GO2RTC_API_PASSWORD` | Random password protecting snapshots and the go2rtc API | Docker: yes |
| `GO2RTC_RTSP_USERNAME` | Username protecting RTSP playback | Docker: yes |
| `GO2RTC_RTSP_PASSWORD` | Random password protecting RTSP playback | Docker: yes |
| `ADC_BRIDGE_BIND_ADDRESS` | Host LAN address go2rtc binds its RTSP and API listeners to, and the address the bridge uses to reach it. Must be the server's real LAN address (e.g. `192.168.1.10`); the `127.0.0.1` fallback does not work with the two-container split. | Docker: yes |

See `.env.example` and `config/config.example.yaml` for the full configuration reference.

## Security

- Use a dedicated Alarm.com login with only the permissions needed to view the selected cameras.
- Keep `.env`, real camera configuration, logs, and Homebridge URLs out of source control.
- go2rtc runs on `network_mode: host`, where Compose `ports:` is ignored — the `listen:` addresses in `config/go2rtc.yaml` are the only thing keeping ports 8554 and 1984 off every interface. Set `ADC_BRIDGE_BIND_ADDRESS` to one trusted LAN address and restrict both ports at the host firewall.
- go2rtc requires Basic authentication for snapshot/API requests, loopback included (`local_auth: true`), and for every RTSP request that does not arrive over loopback — go2rtc skips RTSP auth for loopback unconditionally, so that protection comes from binding to the LAN address rather than from a setting. Its unused WebRTC listener is disabled; the SRTP listener is required once native HomeKit is configured.
- Both containers run without root privileges, drop Linux capabilities, and use a read-only filesystem. The bridge image is pinned to a base-image digest; the go2rtc image is built from source (HKSV is unreleased) with its toolchain pinned by digest and its source pinned to a commit SHA — see `docs/SECURITY_AUDIT.md`.
- This remains an unofficial cloud integration. Alarm.com can change or restrict the endpoints at any time.

## Dependencies

- [node-alarm-dot-com](https://github.com/node-alarm-dot-com/node-alarm-dot-com) — Alarm.com authentication
- [werift](https://github.com/nicknisi/werift-webrtc) — Pure TypeScript WebRTC (server-side PeerConnection)
- [ws](https://github.com/websockets/ws) — WebSocket client for ADC signaling
- [go2rtc](https://github.com/AlexxIT/go2rtc) — RTSP server (accepts ffmpeg push, serves to clients)
- [pino](https://github.com/pinojs/pino) — Structured logging
- ffmpeg — RTP → RTSP transcoding (copy mode, no re-encoding)

## Limitations

### Not a 24/7 stream

ADC cameras are designed for on-demand live view, not continuous streaming. The bridge holds a perpetual live view session by refreshing tokens every 10 minutes, but this is a workaround — ADC does not officially support persistent streaming. ADC telemetry confirms there is no server-enforced WebRTC session timeout, so the 10-minute interval is conservative.

### API rate limits

Alarm.com may ban accounts that poll too aggressively. Known safe minimums (from [homebridge-node-alarm-dot-com](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com)):

- **Session re-authentication**: ≥10 minutes (bridge uses 55 min)
- **Device polling**: ≥60 seconds (bridge uses 10 min per camera)

With multiple cameras, aggregate API load scales linearly — 3 cameras means a video token API call roughly every 200 seconds.

### Retry limits

Exponential backoff bounds the *rate* between attempts but not the *duration* of
attempting: a saturated ladder is still an infinite loop. Each of the three
Alarm.com retry loops — the video token poll, the stream retry ladder, and the
event WebSocket — is therefore wrapped in a circuit breaker. After a run of
consecutive failures the loop pauses, logs once at `error`, and continues only as
occasional probes on an escalating cooldown (5 min → 15 min → 30 min → 1 hour,
then hourly). It probes indefinitely and closes on the first success, so recovery
needs no restart.

An open circuit appears in the periodic status line as `(circuit open)` next to
the affected camera, or as `eventCircuit: open` for the event stream.

The breaker treats "did not produce a usable result" as the failure, not "threw".
Alarm.com answers a camera it cannot reach with HTTP 200 and `errorEnum: 0`, and
simply omits the WebRTC block — so a breaker counting exceptions would sit closed
through exactly the outage it exists for.

## Future exploration

### Native HKSV via go2rtc ([#11](https://github.com/Omar-L/adc-video-bridge/issues/11))

go2rtc PR [AlexxIT/go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) adds native HomeKit Secure Video support with a standalone `pkg/hksv/` library. This would eliminate the entire Homebridge stack — go2rtc would expose cameras directly to Apple Home with H.264 passthrough (no re-encoding), lower latency, and motion events via a simple HTTP API. See issue [#11](https://github.com/Omar-L/adc-video-bridge/issues/11) for the full analysis and phased rollout plan.
