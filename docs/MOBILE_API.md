# The Alarm.com mobile API

Everything known about `mobile.alarm.com`, what is built against it, and the one thing still unresolved.

**Why this matters:** the per-camera RTSP endpoints and credentials that make local
streaming possible exist **only** on this API. The `www.alarm.com/web/api/…` surface this
project was built on does not expose them, and neither does the Alarm.com web portal. So
today they must be extracted by proxying the phone app — which is fine for one developer
and impossible to ask of anyone adopting this project.

🔑 **Closing that gap is the single highest-value piece of work remaining.** With a client
here, onboarding becomes "type your Alarm.com username and password"; without it,
onboarding requires a TLS-intercepting proxy and a trusted CA certificate on a phone.
⚠️ **Status: the client is BUILT and unit-tested, but no live sign-in has succeeded yet.**
See "Measured, but PROBABLY CONFOUNDED" below — the remaining evidence is likely rate-limit
noise, so the next step is one attempt from a cold start, not more code.

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

## The login call — CAPTURED and implemented

```
POST https://mobile.alarm.com/MobileServlet/SubmitRequest.aspx
Content-Type: application/x-www-form-urlencoded
User-Agent: MoniAlarm/<version> CFNetwork/<v> Darwin/<v>

Action=UberLoginNew&Username=<email>&Password=<PLAINTEXT>&MobileDeviceUid=<uuid>
&TwoFactorId=<trusted-device token>&… ~18 more client-identification fields
```

🔑 **The password is sent in PLAINTEXT — there is no key derivation to reverse.** An earlier
hypothesis that the 32-hex `Password` on other calls was a hash of the account password was
tested and disproved; that value is the **session token** under a confusingly reused parameter
name.

**Response** — XML, gzipped, `Content-Type: text/html`:

```
<lnr st="<32-hex session token>" lr="0" tfas="0" dcid="<customer id>" …>
  <cli model="ADC-V723" cd="Front Door" did="2050" UnitId="10000001"
       srt="true" SupportsWebRTC="true" l="<user>" p="<pass>"
       lre="rtsp://user:pass@<lan-ip>:<port>/s1"
       pre="…" dre="…" re="…" />
</lnr>
```

🔑 **The login response contains the cameras — no second call is needed.** `<cli>` is one
camera; `lre` is the local RTSP endpoint, `l`/`p` the credentials, and `UnitId` + `did`
reconstruct the **web API's** camera id, so the two surfaces correlate without a lookup.

### Measured, and trustworthy

- 🔴 **The response is gzipped and `fetch` does NOT transparently decode it.** `res.text()`
  yields compressed bytes as mojibake, which parses as "not a login document" — identical to a
  rejected login. The client gunzips explicitly.
- 🔴 **A REJECTED login still returns HTTP 200 with a well-formed `<lnr>`.** Only `lr`
  distinguishes them: `0` is success. Trusting the status code accepts a failed sign-in.
- 🔴 **An unrecognised request returns an EMPTY body** — HTTP 200, zero bytes, no error
  document at all. There is no status code, message, or distinction between causes. Any client
  built against this must translate that silence into an explanation, because the API gives none.

### ⚠️ Measured, but PROBABLY CONFOUNDED — do not build on these

A sequence of ~9 sign-in attempts was made in one evening while varying `MobileDeviceUid`,
`TwoFactorId`, the field set and `HashCode`. The **first** attempts returned parseable `<lnr>`
documents; **every attempt after that returned an empty body regardless of what was varied**,
including a repeat of the app's complete field set with captured values.

🔑 **That pattern fits RATE LIMITING far better than it fits field validation.** `README.md`
already documents Alarm.com banning accounts that poll. If the later responses were throttle
responses, then the conclusions drawn from them — "TwoFactorId is validated", "the device UID
must be known", "HashCode is required" — are measurements of the throttle, not of the API.

➡️ **Retry from a cold start**: leave it alone for several hours, then make **ONE** attempt
with the app's exact captured values. Judge from that single result. Do not permute.

⚠️ The lesson generalises past this API: **when every variation returns the same failure, stop
varying and suspect the channel.** Nine attempts produced one real datum and a lot of noise.

## What is built

- **`src/mobile/mobile-api.ts`** — `mobileLogin()` performs the single request and returns the
  cameras. Makes **one** request and never retries.
- **`npm run discover:local`** (`src/discover-local-cli.ts`) — signs in and prints ready-to-paste
  blocks for `config.yaml`, `.env` and `go2rtc.yaml`, including suggested HomeKit pins and
  `motion: detect` thresholds. Credentials come from the environment, never arguments, so they
  do not land in shell history or `ps`.

```bash
export ADC_USERNAME=... ADC_PASSWORD=...
export ADC_MOBILE_TWO_FACTOR_ID=...     # if the account uses 2FA
npm run discover:local
```

💡 `ADC_MOBILE_DEVICE_UID` is generated if unset and printed so it can be persisted — Alarm.com
ties trusted-device state to it, so a fresh UUID each run looks like a new device.

**Still to do once a live sign-in succeeds:** refresh endpoints at runtime so a camera changing
address self-heals, rather than only at setup.

⚠️ **Rate limits and lockout are real.** `README.md` documents Alarm.com banning accounts
that poll aggressively. Any development against the login endpoint should be
hand-triggered, never in a retry loop, and should reuse a captured token wherever possible.

💡 **Endpoint stability is better than feared** — a camera's port survived an IP change, and
DHCP reservations pin the address (`INVARIANTS.md`). So this client is about *onboarding*,
not about keeping a working install working. That reframing matters: it can be built
deliberately rather than urgently.
