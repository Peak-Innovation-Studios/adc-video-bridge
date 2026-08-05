# Setup Guide

End-to-end walkthrough for deploying adc-video-bridge on a server and connecting it to Homebridge for live streaming and motion notifications in Apple HomeKit.

## Prerequisites

- A server or machine that can run Docker (Linux, macOS, etc.)
- An Alarm.com account with cameras that support end-to-end WebRTC streaming (e.g. ADC-V723)
- [Homebridge](https://homebridge.io) with the maintained [`@homebridge-plugins/homebridge-camera-ffmpeg`](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg) plugin installed

Use a dedicated Alarm.com login with only camera-viewing permissions when your provider supports one.

## Step 1: Discover your cameras

Clone the repo and run the discovery tool to find your camera IDs:

```bash
git clone https://github.com/Peak-Innovation-Studios/adc-video-bridge.git
cd adc-video-bridge
npm ci

# Set credentials temporarily for discovery
export ADC_USERNAME="your@email.com"
export ADC_PASSWORD="yourpassword"

npx tsx src/discover.ts
```

This prints a table of cameras on your account and outputs ready-to-paste YAML for the config files. Note the camera IDs and names.

## Step 2: Configure the bridge

Copy the example configs:

```bash
cp .env.example .env
cp config/config.example.yaml config/config.yaml
cp config/go2rtc.example.yaml config/go2rtc.yaml
chmod 600 .env config/config.yaml config/go2rtc.yaml
```

Put the Alarm.com credentials and unique random go2rtc passwords in `.env`. Keep `.env` untracked.

`ADC_BRIDGE_BIND_ADDRESS` must be set to the host's real LAN address — the `127.0.0.1` default does not work with this deployment's container split. go2rtc runs on `network_mode: host` and binds to `${GO2RTC_BIND}` (fed from this variable); the bridge itself stays on the default Docker network, so its own `localhost` is a private per-container loopback that cannot reach the host's `127.0.0.1` either. Set this to the host's LAN address regardless of where Homebridge runs, and use that same address for `go2rtc.apiUrl` in `config.yaml` below.

### `config/config.yaml`

Your cameras and optional Homebridge motion integration:

```yaml
cameras:
  - id: "100652375-2048"
    name: "driveway"              # go2rtc stream name (lowercase, no spaces)
    homebridgeName: "Driveway"    # must match the camera name in homebridge-camera-ffmpeg
    quality: "hd"
  - id: "100652375-2050"
    name: "backyard"
    homebridgeName: "Backyard"
    quality: "hd"

go2rtc:
  apiUrl: "http://<server-ip>:1984"
  rtspPort: 8554

# Optional: forward motion events to homebridge-camera-ffmpeg
homebridge:
  motionUrl: "http://<homebridge-ip>:8080"
  motionTimeoutMs: 60000  # reset motion after 60s of no activity

logging:
  level: "info"
```

- `name` is the go2rtc stream identifier — keep it lowercase with no spaces.
- `homebridgeName` must exactly match the camera name you set in homebridge-camera-ffmpeg.
- `go2rtc.apiUrl` must be the host's LAN address — the same one set for `ADC_BRIDGE_BIND_ADDRESS` — not `localhost`. go2rtc runs in its own container on `network_mode: host`; this bridge container runs on the default Docker network and cannot reach go2rtc through its own loopback. The bridge also derives the RTSP push URL from this address, so both the API calls and the video stream break if it points at `localhost`.
- `homebridge.motionUrl` is the base URL of the homebridge-camera-ffmpeg HTTP server. Leave the entire `homebridge` section out to disable motion webhooks.

### `config/go2rtc.yaml`

Each camera needs a matching empty stream entry. The stream names must match the `name` field in `config.yaml`:

```yaml
streams:
  driveway: ""
  backyard: ""

# Under network_mode: host (see docker-compose.yml), `ports:` is ignored —
# these `listen:` values are the ONLY thing keeping go2rtc off every
# interface. A bare `:8554`/`:1984` binds ALL interfaces and fails silently.
# ${GO2RTC_BIND} comes from ADC_BRIDGE_BIND_ADDRESS in .env, which must be
# the host's real LAN address (see above) — the compose fallback of
# 127.0.0.1 is unreachable from the bridge container.
rtsp:
  listen: "${GO2RTC_BIND}:8554"
  username: "${GO2RTC_RTSP_USERNAME}"
  password: "${GO2RTC_RTSP_PASSWORD}"

api:
  listen: "${GO2RTC_BIND}:1984"
  username: "${GO2RTC_API_USERNAME}"
  password: "${GO2RTC_API_PASSWORD}"
  # true, not false: nothing legitimate reaches go2rtc over loopback after
  # the container split, and the compose healthcheck expects a 401.
  local_auth: true

webrtc:
  listen: ""

srtp:
  listen: ""

log:
  level: info
```

## Step 3: Deploy with Docker

```bash
docker compose -f docker-compose.yml up --build -d
```

Verify the streams are running:

```bash
# Check logs
docker compose -f docker-compose.yml logs -f

# Open go2rtc web UI to see active streams
# http://<api-user>:<api-password>@<server-ip>:1984

# Test a stream in VLC
# rtsp://<rtsp-user>:<rtsp-password>@<server-ip>:8554/driveway
```

All three cameras should show `"streaming"` in the periodic status log.

## Step 4: Configure `@homebridge-plugins/homebridge-camera-ffmpeg`

In the Homebridge UI, add a camera to the Camera-ffmpeg platform for each stream. Replace `<server-ip>` with the IP of the machine running adc-video-bridge.

### Per-camera settings

| Setting | Value |
|---------|-------|
| **Name** | `Driveway` (must match `homebridgeName` in config.yaml) |
| **Video Source** | `-i rtsp://<rtsp-user>:<rtsp-password>@<server-ip>:8554/driveway` |
| **Still Image Source** | `-timeout 10000000 -i http://<api-user>:<api-password>@<server-ip>:1984/api/frame.jpeg?src=driveway -vframes 1` |
| **Audio** | disabled |
| **Motion sensor** | enabled |
| **Motion Timeout** | `0` (the bridge controls the reset via `motionTimeoutMs`) |

The `-timeout 10000000` (10 seconds) on the still image source prevents ffmpeg from hanging indefinitely when go2rtc has no frame available during token refresh gaps. Without it, Homebridge can become unresponsive.

### Platform-level settings

| Setting | Value |
|---------|-------|
| **HTTP Port** | `8080` (must match `motionUrl` port in config.yaml) |

Restart Homebridge after making changes.

Use URL-safe random credentials (hex is simplest) or percent-encode reserved characters before placing them in these URLs.

## Step 5: Enable motion notifications in HomeKit

For each camera in the Apple Home app:

1. Long press the camera tile
2. Tap the gear icon (settings)
3. Enable **Notifications** for motion events

Motion is detected via Alarm.com's real-time WebSocket event stream and forwarded to Homebridge automatically. When a camera detects motion, the bridge sends a trigger to homebridge-camera-ffmpeg's HTTP server, which activates the HomeKit motion sensor. After the configured timeout (default 60 seconds), the motion sensor resets.

## Rebuild and redeploy

After pulling new changes or modifying config:

```bash
docker compose -f docker-compose.yml up --build -d
docker compose -f docker-compose.yml logs -f
```

Config file changes (in `config/`) don't require a rebuild — just restart:

```bash
docker compose -f docker-compose.yml restart
```

## Troubleshooting

- **Streams not starting**: Check logs for authentication errors. Verify the `ADC_*` values in `.env` or the configured secret files.
- **Snapshots timing out in Homebridge**: Ensure the still image source includes `-timeout 10000000` before `-i`.
- **Repeated ffmpeg exits, duplicate `front` publishers, or growing snapshot consumers**: Update to the current `main` branch and rebuild the image. Older builds could let a late exit from an intentionally stopped ffmpeg process clear its healthy replacement and repeatedly restart WebRTC. After rebuilding, go2rtc should settle on one publisher per configured camera.
- **`git switch main` reports `invalid reference` on Synology**: The checkout likely fetches only an earlier pilot branch. Follow [Migrate an earlier single-branch pilot checkout](SYNOLOGY.md#migrate-an-earlier-single-branch-pilot-checkout) before rebuilding.
- **Motion not triggering in HomeKit**: Verify `homebridgeName` matches the camera name in homebridge-camera-ffmpeg exactly (case-sensitive). Check that the motion sensor is enabled in the plugin config and notifications are enabled in the Home app.
- **"Camera not found" in motion webhook logs**: The `homebridgeName` doesn't match. The bridge calls `GET http://<motionUrl>/motion?<homebridgeName>` — the name must be an exact match.
- **go2rtc web UI not loading**: Ensure port 1984 is bound to the intended address, permitted by the firewall, and opened with the configured API credentials.
- **Bridge can't reach go2rtc / RTSP push never starts**: `config.yaml`'s `go2rtc.apiUrl` must be the host's LAN address, not `localhost` — the bridge and go2rtc run in separate containers on separate networks after the split. Set it (and `ADC_BRIDGE_BIND_ADDRESS` in `.env`) to the same real LAN address; the `127.0.0.1` default does not work for this topology.

## Local development

For developing without Docker:

```bash
npm ci
cp config/config.example.yaml config/config.yaml
# Export ADC_USERNAME and ADC_PASSWORD, then edit camera IDs in config.yaml.

# Requires go2rtc running separately
npm run dev
```
