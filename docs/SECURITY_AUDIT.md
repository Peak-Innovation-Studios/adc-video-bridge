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
- go2rtc's build and runtime base images are pinned to immutable multi-architecture digests, and its source is pinned to a commit SHA rather than built from an upstream release tag. This is an accepted, documented delta from the previous control, not a silent loss of it: HKSV support ([go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130)) is not in any official go2rtc release, so `Dockerfile.go2rtc` builds go2rtc from source instead of running the previously pinned `alexxit/go2rtc` image. What is lost is an upstream image digest; what replaces it is a digest-pinned toolchain (`golang:1.24.13-alpine3.22@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5`, `alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce` — both multi-arch OCI image index digests, read from `Dockerfile.go2rtc`, not retyped from memory) plus source pinned to commit `506cfa7df508058b0d46a3457130a9cd3a647ae8`, the tip of the `hksv` branch of `skrashevich/go2rtc` (PR AlexxIT/go2rtc#2130, still open). That commit is upstream go2rtc v1.9.14 plus fork-only work — the same upstream version the previously pinned image carried. See `docs/INVARIANTS.md` for the revert trigger that retires this delta.
- Under `network_mode: host`, compose `ports:` is ignored, so `config/go2rtc.yaml`'s `listen:` addresses are the only control keeping the authenticated-but-unencrypted API (1984) and RTSP (8554) ports off every interface. They are set to `${GO2RTC_BIND}:1984` / `${GO2RTC_BIND}:8554`, fed from `ADC_BRIDGE_BIND_ADDRESS`; a bare `:1984` (no host part) binds all interfaces and fails silently — go2rtc starts normally and logs no error.
- `config/go2rtc.yaml` is a secret, not just configuration: go2rtc persists HomeKit `pairings`, `device_id`, and `device_private` back into it, so it is bind-mounted writable rather than read-only. It must be mode 600, and the deployment volume's default ACL (0777) must be re-verified independently — setting the file's own mode is not sufficient if the containing directory grants broader access.
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
