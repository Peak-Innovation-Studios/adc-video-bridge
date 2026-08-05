# Security Audit

Last reviewed: 2026-08-01

## Scope

The review covered Alarm.com authentication and token handling, signaling and event WebSockets, configuration parsing, logging, ffmpeg/go2rtc process boundaries, npm dependencies, the container image, and the Homebridge-facing RTSP and snapshot endpoints.

## Implemented controls

- Alarm.com credentials are supplied through environment variables or secret files rather than the mounted camera configuration.
- Logs redact named credential fields and no longer emit raw signaling messages, account system objects, or ICE candidates.
- Alarm.com signaling and event endpoints must use WSS; WebSocket payloads and handshakes are bounded.
- Camera IDs, RTSP path names, URLs, ports, log levels, duplicate entries, and motion timeouts are validated before network activity begins.
- HTTP calls to go2rtc and Homebridge use bounded timeouts.
- Authentication refreshes are serialized to prevent concurrent Alarm.com logins.
- go2rtc's remote API/snapshot and RTSP endpoints require separate credentials. Unused WebRTC and SRTP listeners are disabled.
- The container runs as a non-root user with all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, bounded temporary storage and log rotation, and an active health check.
- The bridge's build and runtime images (`node:20.19.5-alpine3.22`) are pinned to an immutable multi-architecture digest. Development packages are pruned from the runtime image.
- go2rtc is built from source (`Dockerfile.go2rtc`) rather than the previously pinned `alexxit/go2rtc` image, since HKSV ([go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130)) is not in any release yet — an accepted, documented delta: the lost upstream image digest is replaced by a digest-pinned toolchain (`golang:1.24.13-alpine3.22@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5`, `alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`) plus a source commit pin (`506cfa7df508058b0d46a3457130a9cd3a647ae8`). Revert trigger: `docs/INVARIANTS.md`.
- Under `network_mode: host`, compose `ports:` is ignored — `config/go2rtc.yaml`'s `listen:` addresses (`${GO2RTC_BIND}:1984` / `:8554`, fed from `ADC_BRIDGE_BIND_ADDRESS`) are the only control keeping the unencrypted API and RTSP ports off every interface; a bare `:1984` binds all interfaces silently.
- `config/go2rtc.yaml` is a secret — go2rtc persists HomeKit `pairings`, `device_id`, and `device_private` into it, so it's mounted writable, must be mode 600, and needs the deployment volume's default 0777 ACL independently re-verified.
- Docker build context excludes credentials, real configuration, secret files, logs, local dependencies, and repository metadata.
- CI builds, runs the test suite, and enforces the production dependency audit policy.

## Residual risks

### Unofficial Alarm.com endpoints

The bridge depends on unsupported Alarm.com web endpoints and persistent live-view sessions. Alarm.com can change the protocol, revoke access, rate-limit the account, or prohibit the behavior. Use a dedicated least-privilege Alarm.com login and conservative polling.

### `ip` advisory inherited through werift

`werift-ice` currently depends on `ip@2.0.1`, which is reported under GHSA-2p57-rm9w-gvfp because `ip.isPublic()` can misclassify unusual addresses. The compiled `werift-ice` version used here does not call `ip.isPublic()`; it uses loopback checks plus IP encoding/decoding for ICE and STUN. `npm run audit:prod` allows only this exact advisory and fails if the affected method appears or any other production advisory is introduced.

This is a constrained exception, not a declaration that the dependency is generally safe. Remove the exception when werift drops or fixes the dependency.

### LAN services

Homebridge must reach RTSP and snapshot endpoints. Basic authentication protects both, but traffic is not encrypted on the trusted LAN. Bind to one LAN address, restrict source hosts at the firewall, and do not forward ports 8554, 1984, or the Homebridge motion webhook to the internet.

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
