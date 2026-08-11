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
✅ **STATUS: WORKING. Live sign-in succeeded 2026-08-08 13:04**, returning all cameras with their
local RTSP endpoints. The blocker was a missing body field — `Haiku` — and Alarm.com answers an
incomplete request with a zero-byte HTTP 200 indistinguishable from a rejected sign-in. See
"the empty body was never a rate limit" below.

🔑 **Verified correct, not merely non-empty.** The generated configuration matched a running
production install field-for-field — camera ids, hosts, ports and RTSP credentials — and that
install had been configured by hand from a proxy capture weeks earlier, so it is an
**independent** artifact. A parser reading the wrong attribute would have produced plausible
output and failed this comparison.

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

### The JSON camera list is RICHER than the login response

🔑 The `Json=true` variant returns `CameraItems[]` with fields the `<lnr>` login document does
**not** carry. Confirmed 2026-08-11 from a 2026-08-07 capture. Beyond the endpoints and credentials that
appear in both, it adds at least:

```
SupportsDownstreamAudio  SupportsUpstreamAudio  SupportsFullDuplex  IsAudioOnly
SupportsPanTilt  PanTiltPresetItems  SupportsEnhancedMode  IsInEnhancedMode
SupportsMjpegStreaming  SupportsRecordNow  SupportsCenterCommand
SupportsChangingLiveViewResolutionFromMobile  CameraCalibrationInformation
BufferForMobileRtspDirectStreamingInMs  BufferForMobileRtspVpnStreamingInMs
CameraSessionToken (+ expiry)  Firmware  MacAddress
```

💡 Worth knowing before adding a second call for any of it: **`discover:local` needs none of
these**, and every extra request is another authenticated hit on an API that rate-limits.
🔑 **It already answered one real question for free:** all four audio flags are `false` on all
three cameras here, which is why the local RTSP stream has no `m=audio` line. See baton item 13 —
that is a property of the cameras, not of the local RTSP path.
⚠️ `CameraSessionToken` is in this response. Treat the whole document as secret.

🔑 **The RTSP username is a shared stock account name; the PASSWORD differs per camera.**
Copying one stream URL and changing only the port yields a 401 that presents as a stream
that is simply "offline".

## The login call — CAPTURED and implemented

```
POST https://mobile.alarm.com/MobileServlet/SubmitRequest.aspx
Content-Type: application/x-www-form-urlencoded
User-Agent: MoniAlarm/<version> CFNetwork/<v> Darwin/<v>

Action=UberLoginNew&Username=<email>&Password=<PLAINTEXT>&MobileDeviceUid=<uuid>
&TwoFactorId=<trusted-device token>&HashCode=<10 digits>&Haiku=<ten words.>
&… 17 more client-identification constants
```

🔴 **24 body fields, and ALL of them are required.** A request missing any one returns HTTP 200
with a zero-byte body — no code, no message, nothing to distinguish it from a rejected sign-in.
The full list, verified against a HAR of the real app on 2026-08-08 and pinned by a test:

```
Action  Username  Password  MobileDeviceUid  TwoFactorId  HashCode  Haiku
UseNewSessionManager  RememberMe  DeviceFlavor  MobileDeviceType  Culture
MobileManufacturer  MobileDeviceModel  MobileDeviceOsVersion  ApplicationBuildNumber
BuildString  GmtOffsetMinutes  IncludeRealTimeUpdates  IncludeDealerBranding
IncludeDashboard  IncludePushSettings  IncludeAlarmModeEventsFilter
PerformPushDeviceTokenCheck
```

**The four that must be captured per install** — the rest are constants in `mobile-api.ts`:

| field | shape | notes |
|---|---|---|
| `MobileDeviceUid` | UUID, 36 chars | trusted-device state is tied to it; persist it |
| `TwoFactorId` | 73 chars, UUID-ish | rotates on another sign-in |
| `HashCode` | 10 digits | ✅ stable per install, reusable — **not** a timestamp |
| `Haiku` | ~60 chars, ten words separated by spaces, ending `.` | 🔴 the field whose absence caused every empty body. The name is literal — it is a human-readable device fingerprint, all letters, no digits |

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

### 🔴 RESOLVED — the empty body was never a rate limit. A field was missing.

**The cause is `Haiku`, a 24th body field this client did not send.**

The history: ~9 sign-in attempts in one evening (2026-08-07) varying `MobileDeviceUid`,
`TwoFactorId`, the field set and `HashCode`. The first returned `<lnr lr="1">`; every one
after returned an empty body regardless of what was varied. That was read as rate limiting,
because it fits — `README.md` documents Alarm.com banning accounts that poll.

🔑 **The cold-start test refuted it.** On 2026-08-08, after ~15 hours of silence, a single
attempt with the full captured field set returned the **byte-identical** empty body
(`HTTP 200, content-encoding=none, 0 raw bytes`). **A throttle does not survive 15 hours.**
That one measurement moved the diagnosis from "we were punished" to "our request is wrong".

🔑 **The answer then cost ZERO further logins.** A HAR of the real app was already on disk.
Diffing *structure only* — field and header names, never values — showed the app sends **24**
body fields and this client sent **23**. The single name absent from ours was `Haiku`.

Two further findings from the same offline diff, both worth having:

- ✅ **Every one of the 18 hardcoded constants already matched the app exactly** — `RememberMe:
  "True"`, `BuildString: "5.13.1"`, `ApplicationBuildNumber: "2051"`, `GmtOffsetMinutes: "-300"`,
  all of them. The values were never the problem, so nothing there needs revisiting.
- ✅ **`HashCode` is NOT a timestamp.** Its 10-digit width suggests Unix epoch seconds, which
  would make a captured one stale by construction. Tested against the capture's own
  `startedDateTime`: off by ~1188 days. It is a **stable per-install value and a captured one is
  reusable.**

⚠️ **Two lessons, and the second is the expensive one.**
**(1)** When every variation returns the same failure, stop varying and suspect the channel —
nine attempts produced one real datum and a lot of noise.
**(2)** 🔴 **The refutation and the answer both came from evidence already sitting on disk.**
The capture that identified the missing field was captured *before* the nine attempts began.
Diffing your request against a known-good one costs nothing and risks nothing; probing a live
authentication endpoint costs a login against an account that can be locked. **Exhaust the
offline comparison first.**

## What is built

- **`src/mobile/mobile-api.ts`** — `mobileLogin()` performs the single request and returns the
  cameras. Makes **one** request and never retries.
- **`npm run discover:local`** (`src/discover-local-cli.ts`) — signs in and prints ready-to-paste
  blocks for `config.yaml`, `.env` and `go2rtc.yaml`, including suggested HomeKit pins and
  `motion: detect` thresholds. Credentials come from the environment, never arguments, so they
  do not land in shell history or `ps`.
- **`npm run discover:local -- --write`** — merges those blocks into the three files in place
  instead of printing them. `src/config-writer.ts` holds the merge as pure `string → string`
  functions; `src/config-writer-fs.ts` applies the verdict to disk.

```bash
export ADC_USERNAME=... ADC_PASSWORD=...
export ADC_MOBILE_HAIKU=...             # 🔴 REQUIRED — see the field table above
export ADC_MOBILE_DEVICE_UID=...        # persist it; trusted-device state is tied to it
export ADC_MOBILE_TWO_FACTOR_ID=...     # if the account uses 2FA
export ADC_MOBILE_HASH_CODE=...         # stable per install, reusable
npm run discover:local                  # print the blocks
npm run discover:local -- --write       # or merge them in place
```

🔴 **The CLI REFUSES to run without `ADC_MOBILE_HAIKU`**, rather than spend a login attempt on a
request already known to be incomplete. The *library* keeps it optional — `mobileLogin()` should
not impose policy — but at the CLI the cost of finding out is a real login against a lockable
account. Pull it from a proxied capture of the app's login:

```bash
grep -ohE 'Haiku=[^&]+' <capture-file> | head -1
```

### What `--write` will and will not do

🔴 **It REFUSES `config/go2rtc.yaml` outright once any accessory has `pairings`.** go2rtc writes
that file itself, and `device_private` — the private half of a completed HomeKit pairing — exists
nowhere else and is not recoverable from a backup that predates it. A refused file is printed for
hand-merging instead, so the paired case degrades to the old behaviour rather than failing.

Also true of every write:

- **Merges INTO existing maps**, never appends. A second `streams:` key would be a duplicate
  top-level key, which `verify-config.ts` documents as silently discarding one block *and*
  disabling go2rtc's own config writes.
- **Never overwrites an existing key.** A stream, camera `id` or env var that is already present is
  reported and left exactly as it was. Cameras are matched on Alarm.com `id`, not name or position,
  so a camera you renamed is still recognised.
- **Backs up before writing** (`<file>.bak-<stamp>`), and forces both the file and its backup to
  mode 0600 — all three carry credentials, and `writeFileSync`'s `mode` applies only on creation.
- **Preserves comments**, via `yaml`'s `parseDocument` rather than parse-and-restringify.
- **Refuses a file it cannot parse** rather than rewriting it from scratch.

⚠️ Backup paths are covered by the existing `config/*.yaml*` and `.env.*` ignore rules — verified by
canary, together with a control confirming `config/config.example.yaml` is still *not* ignored.

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
