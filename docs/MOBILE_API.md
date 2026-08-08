# The Alarm.com mobile API

Everything known about `mobile.alarm.com`, and the one thing still missing.

**Why this matters:** the per-camera RTSP endpoints and credentials that make local
streaming possible exist **only** on this API. The `www.alarm.com/web/api/…` surface this
project was built on does not expose them, and neither does the Alarm.com web portal. So
today they must be extracted by proxying the phone app — which is fine for one developer
and impossible to ask of anyone adopting this project.

🔑 **Closing that gap is the single highest-value piece of work remaining.** With a client
here, onboarding becomes "type your Alarm.com username and password"; without it,
onboarding requires a TLS-intercepting proxy and a trusted CA certificate on a phone.

---

## What it is

A **separate, legacy RPC-over-HTTP API**, unrelated to the modern REST surface. Every call
is a form POST with an `Action` parameter, returning XML or JSON depending on a `Json=true`
flag. Observed actions include `GetAllCameras`-style camera enumeration,
`GetWebsocketAuthToken`, `GetAllFences`, `GetLiveVideoStream`, `GetAllSirenDevices`.

⚠️ It is not documented, not supported, and can change without notice — the same residual
risk `SECURITY_AUDIT.md` already records for the web API.

## What the camera list returns, per camera

```
LocalRtspEndpoint       rtsp://<user>:<pass>@<lan-ip>:<port>/s1
PublicRtspEndpoint      rtsp://<user>:<pass>@<wan-ip>:<port>/s1
VpnRtspEndpoint         rtsp://<user>:<pass>@videostreamna02.alarm.com:8090/s1
Login / Password        per-camera RTSP credentials
DeviceId                the numeric suffix of the web API's camera id
MacAddress              useful for finding a camera that changed address
Model / Firmware
SupportsRtspStreaming   true
SupportsWebRTC          🔴 FALSE on ADC-V515 — see INVARIANTS.md
DirectConnectionMayWork true
```

🔎 **The web API's camera id is `<prefix>-<DeviceId>`**, where the prefix is shared across
the account. Verified 2026-08-07: constructing ids this way reproduced the known-good id
exactly, so the two APIs can be correlated without a second lookup.

🔑 **The RTSP username is a shared stock account name; the PASSWORD differs per camera.**
Copying one stream URL and changing only the port yields a 401 that presents as a stream
that is simply "offline".

## Authentication — what is known

Authenticated calls carry a mix of these, and **not all calls use the same set**:

| parameter | observed on | notes |
|---|---|---|
| `Password` | `GetAllFences` | 32 hex chars. **NOT a hash of the account password** — tested against md5/sha1 of the password alone and combined with the username; none match. It is a minted device token. |
| `SessionToken` | `GetWebsocketAuthToken` | 32 hex chars |
| `DeviceUid` / `MobileDeviceUid` | both | a stable per-install UUID |
| `TwoFactorId` | `GetWebsocketAuthToken` | suggests a durable trusted-device token, like the web API's `ADC_MFA_TOKEN` |
| `CustomerId` | `GetWebsocketAuthToken` | account identifier |
| `ApplicationBuildNumber`, `DeviceFlavor`, `Haiku` | both | client identification; `Haiku` is a fixed string the app sends verbatim |

## 🔴 What is MISSING — and exactly how to capture it

**The login exchange.** Every capture so far is of an *already-authenticated* session, so
the parameters above are known but not the call that **mints** them. Guessing at an auth
endpoint risks locking the account, so this must be captured rather than inferred.

**Capture procedure — needed once, by someone with a proxy already working:**

1. Start the intercepting proxy (Proxyman, mitmproxy, Charles) with its CA trusted on the phone.
2. **Sign OUT of the Alarm.com/Brinks app completely.** A resumed session skips the exchange.
3. Sign back in, including any two-factor prompt.
4. Open the camera list so the enumeration call is captured too.
5. Export **all** `mobile.alarm.com` traffic.

⚠️ **Export request URLs, methods and HEADERS — not just bodies.** The existing captures
are body-only, which is why the parameters are known but the endpoints they were posted to
are not.

🔴 **The captures are full of secrets** — camera RTSP passwords, MAC addresses, LAN and WAN
addresses, session tokens, camera names and home GPS coordinates. `CLAUDE.md` forbids any
of it reaching this repository. Extract what is needed, commit nothing.

## Design sketch, once the login is known

- `src/mobile/mobile-api.ts` — login → durable device token → camera enumeration.
- Store the device token the way the web API's MFA token is stored: an env var or Docker
  secret, obtained once interactively, reused headlessly. This keeps the awkward step out
  of the container.
- Feed `src/discover.ts` so it emits complete `config.yaml` and `go2rtc.yaml` blocks with
  endpoints and credentials filled in.
- Optionally refresh endpoints at runtime, so a camera changing address self-heals.

⚠️ **Rate limits and lockout are real.** `README.md` documents Alarm.com banning accounts
that poll aggressively. Any development against the login endpoint should be
hand-triggered, never in a retry loop, and should reuse a captured token wherever possible.

💡 **Endpoint stability is better than feared** — a camera's port survived an IP change, and
DHCP reservations pin the address (`INVARIANTS.md`). So this client is about *onboarding*,
not about keeping a working install working. That reframing matters: it can be built
deliberately rather than urgently.
