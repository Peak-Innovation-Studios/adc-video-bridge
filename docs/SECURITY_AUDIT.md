# Security Audit

Last reviewed: 2026-08-04

## Scope

The review covered Alarm.com authentication and token handling, signaling and event WebSockets, configuration parsing, logging, ffmpeg/go2rtc process boundaries, npm dependencies, the container image, and the Homebridge-facing RTSP and snapshot endpoints.

## Implemented controls

- Alarm.com credentials are supplied through environment variables or secret files rather than the mounted camera configuration.
- Logs redact named credential fields and no longer emit raw signaling messages, account system objects, or ICE candidates.
- Alarm.com signaling and event endpoints must use WSS; WebSocket payloads and handshakes are bounded.
- Camera IDs, RTSP path names, URLs, ports, log levels, duplicate entries, and motion timeouts are validated before network activity begins.
- HTTP calls to go2rtc and Homebridge use bounded timeouts.
- Authentication refreshes are serialized to prevent concurrent Alarm.com logins.
- go2rtc's API/snapshot and RTSP endpoints require separate credentials. Compose refuses to start if any of the four is unset or empty. The unused WebRTC listener is disabled. ⚠️ SRTP must NOT be disabled once `homekit:` is configured — an empty `srtp.listen` leaves `srtp.Server` nil and HomeKit streams fail with "can't work without SRTP server", presenting as a paired camera showing "No Response".
  ⚠️ **The two endpoints enforce differently, and only one of them is governed by config.** `local_auth: true` makes the **API/snapshot** module authenticate every request *including* loopback. **RTSP has no such setting** — `internal/rtsp/rtsp.go` skips auth for loopback connections unconditionally (`&& !conn.RemoteAddr().(*net.TCPAddr).IP.IsLoopback()`), and there is no `local_auth` key under `rtsp:`. In practice every RTSP request still authenticates, but that guarantee comes from the **bind address**, not from a toggle: go2rtc listens on the LAN address only, so no connection arrives over loopback. 🔴 Binding it to `127.0.0.1` or `0.0.0.0` would expose unauthenticated RTSP to anything on the host — which is why `ADC_BRIDGE_BIND_ADDRESS` is required rather than defaulted.
- Both containers run as a non-root user with all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, bounded temporary storage, and log rotation. go2rtc has an active health check the bridge gates its start on; the bridge deliberately has none, since it listens on nothing after the split.
- The bridge mounts only `config/config.yaml`, not the whole `config/` directory, so the Alarm.com-credential container cannot read `config/go2rtc.yaml`.
- The bridge's build and runtime images (`node:20.19.5-alpine3.22`) are pinned to an immutable multi-architecture digest. Development packages are pruned from the runtime image.
- go2rtc is built from source ([HKSV#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is unreleased), so the `alexxit/go2rtc` image digest is replaced rather than lost: toolchain by digest (`golang:1.24.13-alpine3.22@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5`, `alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`), source by commit `506cfa7df508058b0d46a3457130a9cd3a647ae8`. Revert trigger: `docs/INVARIANTS.md`.
- Under `network_mode: host`, compose `ports:` is ignored: `config/go2rtc.yaml`'s `listen:` addresses are the only control keeping the unencrypted API and RTSP off every interface. A bare `:1984` binds all interfaces silently.
- `config/go2rtc.yaml` is a secret (go2rtc persists HomeKit `pairings`, `device_id`, `device_private` into it): mounted writable, mode 600, and the volume's default 0777 ACL re-verified separately.
- Docker build context excludes credentials, real configuration, secret files, logs, local dependencies, and repository metadata. 🔴 **The config rules match by PATTERN, not by filename, and must stay that way.** Until 2026-08-06 `.gitignore` and `.dockerignore` each listed the two exact names `config/config.yaml` and `config/go2rtc.yaml`; `config/go2rtc.yaml.bak-pre-hksv` and `.bak-pre-srtp` on the NAS — carrying HomeKit `pairings` and `device_private` — matched neither, leaving them untracked-but-stageable by `git add -A` and present in the build context. Now `config/*.yaml*` with `!config/*.example.yaml`. ⚠️ **An exclusion cannot be verified by observing that nothing bad appeared** — a correct rule and a too-narrow one produce identical clean output. Verify by planting a canary and confirming it is suppressed, *and* that it escapes when the rule is removed (done 2026-08-06 for `.gitignore` via `git check-ignore`; `.dockerignore` is inspection-only here, and is defence in depth regardless, since neither Dockerfile `COPY`s `config/`).
- The local RTSP relay (`src/rtsp/tunnel-relay.ts`) holds **no camera credentials**. It relays bytes, so the camera's own Digest challenge passes through untouched and go2rtc authenticates end to end — an unauthorized caller reaching a relay port gets the camera's own 401, and there is no relay-side credential to leave unset. The camera credentials therefore live in `config/go2rtc.yaml`, already a mode-600 secret holding the HomeKit `device_private`, and are unreachable from the Alarm.com-credential container, which does not mount that file. Relay ports are published to the LAN address only, exactly like the status port, and concurrent connections are bounded (`localRtsp.maxConnections`, default 8) because the tunnel to the camera is opened before the RTSP-layer authentication happens over it.
  ⚠️ **The TLS link to the camera is encrypted but NOT authenticated.** Certificate verification is disabled because the cameras present a self-signed `CN=www.alarm.com` certificate that expired in December 2024 and nothing about it is under our control. On-path tampering between the bridge and the camera on the trusted LAN is therefore not defended; the camera's Digest authentication is what prevents an unauthorized *client* from obtaining video.
- CI builds both images and asserts each runs, runs the test suite, and enforces the production dependency audit policy.

## Residual risks

### Unofficial Alarm.com endpoints

The bridge depends on unsupported Alarm.com web endpoints and persistent live-view sessions. Alarm.com can change the protocol, revoke access, rate-limit the account, or prohibit the behavior. Use a dedicated least-privilege Alarm.com login and conservative polling.

### `ip` advisory inherited through werift

`werift-ice` currently depends on `ip@2.0.1`, which is reported under GHSA-2p57-rm9w-gvfp because `ip.isPublic()` can misclassify unusual addresses. The compiled `werift-ice` version used here does not call `ip.isPublic()`; it uses loopback checks plus IP encoding/decoding for ICE and STUN. `npm run audit:prod` allows only this exact advisory and fails if the affected method appears or any other production advisory is introduced.

This is a constrained exception, not a declaration that the dependency is generally safe. Remove the exception when werift drops or fixes the dependency.

### LAN services

Homebridge must reach RTSP and snapshot endpoints. Basic authentication protects both, but traffic is not encrypted on the trusted LAN. Bind to one LAN address, restrict source hosts at the firewall, and do not forward ports 8554, 1984, or the Homebridge motion webhook to the internet.

### go2rtc RTSP password in the bridge's process table

ffmpeg's RTSP muxer accepts credentials only inside the output URL, so the go2rtc RTSP password is an argv element of every ffmpeg child (`src/camera/camera-stream.ts`). Anyone who can read the bridge container's `/proc` — or run `docker top` / `docker exec` against it — can read that password. Accepted: there is no ffmpeg-side alternative, the value protects only a LAN RTSP endpoint, and it is distinct from the Alarm.com and go2rtc API credentials. Logging is separately defended — ffmpeg's stderr, its spawn errors, and the `rtspUrl`/`rtspBaseUrl` log fields are all scrubbed or redacted.

### Continuous cloud streaming

The camera is designed for on-demand viewing. Holding a long-running cloud stream can consume bandwidth, introduce short reconnection events, and behave differently after provider-side changes. Monitor logs and account access after deployment.

## Verification commands

```bash
npm ci
npm run build
npm test
npm run audit:prod
docker compose config
docker compose build
```
