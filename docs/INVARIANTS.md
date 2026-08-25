# Invariants and hard-won gotchas

Things that must not be undone, re-diagnosed, or "simplified" — each one cost a session to learn.
`docs/SECURITY_AUDIT.md` covers the credential, network, container and dependency invariants; this
file covers the behavioural ones.

Split out of `docs/AGENT_HANDOFF.md` on 2026-08-04. It lives here because it changes only when the
**design** changes, whereas the baton is rewritten every session — mixing the two buried the three
lines that had actually moved.

**This is reference. Search it; do not read it front to back.** Reach for it before changing
reconnect/session lifecycle, the circuit breaker, or anything touching Homebridge on the Synology.

---

## Diagnosis

### 🧭 "No video" — diagnose in THIS order. Cheapest and most decisive first

A full session was spent on 2026-08-03 reaching a confident, well-evidenced, **wrong** conclusion by
starting at step 3.

1. **Can Alarm.com's own web player AND phone app stream the camera?** If neither can, stop — it is
   not our code. **If they disagree with each other, suspect the CLIENT ENVIRONMENT FIRST, then the
   network path** — two first-party clients differing cannot be explained by any server-side theory,
   but it is usually the browser, not the network.
   🔴 **Measured 2026-08-06: Safari's iCloud Private Relay ("Hide IP address → from Trackers and
   Websites") stops Alarm.com video loading entirely.** Toggling it off, every camera plays. A masked
   IP breaks WebRTC. A Safari content blocker was separately blocking `alarm.com/web/api/...` calls.
   ⚠️ **Neither produces a console error you would recognise** — the blocker's messages look like
   ad-blocking noise, and Private Relay just yields a player that never starts.
   ➡️ So before using "their own web player fails" as evidence: retest with Private Relay **off**,
   content blockers **off**, extensions **off**. It was cited to Brinks-facing notes on 2026-08-06
   and had to be retracted. **A browser is a noisy instrument; an authenticated API call from a
   headless box is not. Do not let the noisy one corroborate the quiet one.**
2. Check camera WiFi signal. Power-cycle it. Re-probe.
3. Only then read our logs.

### 🔴 `"Camera <id> has not yet dialed in"` means the CAMERA is offline. It is not our bug

Alarm.com's signaling server closes the WebSocket with code **1000** (a *normal* closure, which is
why it does not look like an error) carrying this message. It means the camera has not registered
with ADC's video service — there is nothing for us to connect to.

Correct response: **fix the camera's connectivity.** Do not debug the bridge. The retry ladder and
the circuit breaker are already handling it correctly by design — 12 signaling attempts, then the
manager's `60s → 120s → 300s → 600s` backoff, then the circuit opens at 6 failures.

⚠️ **Suspect recent WiFi work first.** Measured 2026-08-04: the camera stopped dialing in
immediately after the WiFi was "improved", while a bridge rebuild happened in the same window — the
rebuild was blamed first and was innocent. If an SSID, band, AP or passphrase changed, the camera
must be **re-provisioned onto the new network**; many of these cameras are 2.4 GHz-only and will
silently fail to join a 5 GHz or band-steered SSID.

### 🔴 "It works in the Brinks/Alarm.com app" does NOT mean the camera is dialed in for US

Measured 2026-08-04: the app streamed the camera fine while the bridge — restarted fresh, new token,
no backoff — was still refused with `"has not yet dialed in"` on every attempt.

The two are not the same request. The app is an **on-demand** client: it asks, the camera wakes for
that request, it streams, everything sleeps again. It can also fall back to Alarm.com's **proxy**
path, which does not need the camera to hold a direct registration at all. This bridge is a
**perpetual** client and needs the camera dialed in *continuously*, including when nobody is
watching — a property the app never exercises and therefore never demonstrates.

So the app is still the right **step 1** (it separates "camera totally dead" from "something else"),
but a passing app check does **not** clear the camera. Only the bridge reaching `sessionStarted`
does.

### 🔴 `probe.js` returning a Direct config does NOT prove the camera is online

This cost **three** wrong conclusions in one session (2026-08-04). `probe.js` logged in, enumerated
both video sources, reported `errorEnum: 0` and a **non-null `endToEndWebrtcConnectionInfo`** —
continuously, while not a single session could be established.

Alarm.com serves that config **from its database**, not from the device. So `probe.js` proves only
that *our credentials and the ADC config API work*. It says nothing about whether a session can
actually be set up. Only the bridge reaching **`sessionStarted`** proves that.

⚠️ **The same trap has three faces. All were raised and retracted in that one session:**

| Read as… | Actually |
|---|---|
| `janusGatewayUrl` / `proxyStreamTimeoutTime` present ⇒ "demoted to Proxy" | Those fields are in the payload **always**, as fallback config |
| Signaling says "not dialed in" ⇒ "camera is offline" | It streamed in the app the whole time |
| `172.20.14.x` in the payload ⇒ "camera moved to another subnet" | `coturnAddressesTuplets` — **Alarm.com's own TURN servers** |

🔑 **The single underlying error: reading a field of ADC's payload as a statement about the camera,
when it is a statement about ADC's own plumbing.** Before concluding anything about the camera from
this payload, ask which component the field actually describes.

### 🔴 The MOBILE API exposes local RTSP endpoints — the web API does not. The README premise was wrong

Measured 2026-08-07 by proxying the Brinks iOS app. `mobile.alarm.com` is a **separate, legacy
RPC-over-HTTP API** — form POSTs with an `Action` parameter, returning XML or JSON. It is not the
`www.alarm.com/web/api/…` surface this project uses.

Its camera list returns, per camera: `LocalRtspEndpoint`, `PublicRtspEndpoint`, `VpnRtspEndpoint`,
`Login`, `Password`, `SupportsRtspStreaming: true`, `DirectConnectionMayWork: true`. The app's own
telemetry then reports `protocolType: "RTSP"`, `connectionType: "DIRECT"`, `isWebRTCFallback: false`.

⚠️ **`SupportsWebRTC` is per MODEL and it is FALSE on ADC-V515.** Only the ADC-V723 reports `true`.
So the WebRTC bridge **cannot ever serve a V515**, no matter what Alarm.com fixes. Local RTSP is not
an optimisation for those cameras; it is the only path.

🔑 **Do not "correct" the README back.** Its original claim — cameras cannot be reached over RTSP —
was inherited from the browser integration this project was ported from, which only ever saw the web
API. It is true of that API and false of the platform.

### ✅ SOLVED — the local port is RTSP tunnelled over HTTPS, and stock ffmpeg speaks it

Measured 2026-08-07. **All three cameras deliver live 1080p H.264 with no cloud, no WebRTC and no
video token** — including both ADC-V515s, which `SupportsWebRTC: false` puts permanently out of the
bridge's reach. This is the whole command:

```bash
ffprobe -rtsp_transport https -i "rtsp://<user>:<pass>@<lan-ip>:<port>/s1"
```

🔑 **The URL scheme and the transport must disagree, and that is the entire trick.**
`rtsps://` makes ffmpeg put `rtsps://…/s1` in the RTSP *request line*; the camera runs LIVE555, which
cannot parse that scheme into a stream name and answers **`404 Stream Not Found`** — which reads
exactly like a wrong path and is not one. Use `rtsp://` in the URL and carry TLS in
`-rtsp_transport https`. ⚠️ `-rtsp_transport http` fails (`Error reading HTTP response: End of file`):
the TLS requirement is real, not incidental.

What the port actually serves, measured through a hand-written tunnel client:

| probe | result |
|---|---|
| `GET /` inside TLS | **200 OK** — it is an ordinary HTTPS server |
| `GET /s1` inside TLS, plain | 404 — `/s1` is not an HTTP resource |
| `GET /s1` + `Accept: application/x-rtsp-tunnelled` + `x-sessioncookie` | **200, `Content-Type: application/x-rtsp-tunnelled`** |
| RTSP `OPTIONS` through the tunnel | **200** — `OPTIONS, DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, GET_PARAMETER, SET_PARAMETER` |
| RTSP `DESCRIBE rtsp://…/s1` | **401**, `Digest realm="RTSP Server"` → **200 + SDP** once answered |

SDP: `LIVE555 Streaming Media v2015.04.22`, one `m=video` track (`track1`), H.264
`packetization-mode=1`, `profile-level-id=4D4028` (Main 4.0), 1920×1080 @ 10 fps.
⚠️ **There is no `m=audio` line at all** — audio passthrough is not merely unimplemented here, the
stream does not carry it. Consistent with "none of these cameras have microphones".

🔎 **Two earlier readings of this port were wrong, and both failed the same way — a probe that
omitted the protocol's own handshake was read as evidence about the target.**
- *"`GET /s1` 404s, so the path is not HTTP"* — it 404s only **without** `Accept:
  application/x-rtsp-tunnelled`. That header is what switches the same path into tunnel mode.
- *"404 not 401, so the credentials were accepted"* — `GET /` returns 200 unauthenticated, so this
  server emits 404s without ever consulting auth. Those responses said nothing about credentials.

⚠️ **`Content-Base: rtsp://0.0.0.0/s1/`** comes back in the DESCRIBE — a LIVE555 quirk when the
server does not know its own address. ffmpeg handles it; a hand-rolled client that follows
`Content-Base` for the `SETUP` control URI will dial 0.0.0.0.

🔴 **Credentials, MAC addresses, LAN/WAN IPs, camera session tokens and camera names from those
captures must NEVER be committed.** `CLAUDE.md` forbids it and the captures are full of them.

### ✅ Two ways to feed go2rtc from the tunnel — both measured 2026-08-07, one needs no ffmpeg

🔴 **go2rtc CANNOT do this natively as shipped.** Checked against the exact pinned commit we build
(`506cfa7…`): zero occurrences of `x-rtsp-tunnelled` or `sessioncookie` anywhere in the source. Its
`rtsps://` handler is RTSP-over-TLS **directly** — TLS then `OPTIONS … RTSP/1.0` — which is precisely
what these cameras answer with `HTTP/1.1 400 Bad Request`. Do not expect `rtsps://` to work.

**Option A — `ffmpeg:` source. No new code; a `config/go2rtc.yaml` edit and a restart.**

```yaml
streams:
  front: ffmpeg:rtsp://<user>:<pass>@<lan-ip>:<port>/s1#input=-fflags nobuffer -flags low_delay -timeout {timeout} -user_agent go2rtc/ffmpeg -rtsp_transport https -i {input}#video=copy
```

🔎 `#input=` takes a raw template with `{input}` substituted and **is not URL-decoded**
(`streams.ParseQuery` splits on `#` and keeps the value verbatim), so spaces are fine — but a literal
`#` inside the value is not. Omitting `#audio=` is deliberate: there is no audio track, and it is
also what makes go2rtc prepend `-allowed_media_types video`.

⚠️ **Verified by reconstructing and running go2rtc's exact command line** (`Args.String()` order is
Bin → Global → Input → Codecs → Output), on Kaikoura's ffmpeg 7.1.5, publishing into the live stream:

```bash
ffmpeg -nostdin -hide_banner -v error -allowed_media_types video \
  -fflags nobuffer -flags low_delay -timeout 5000000 -user_agent go2rtc/ffmpeg \
  -rtsp_transport https -i "rtsp://<user>:<pass>@<lan-ip>:<port>/s1" \
  -c:v copy -user_agent ffmpeg/go2rtc -rtsp_transport tcp -f rtsp "<go2rtc-rtsp-url>"
```

⚠️ `-nostdin` is a test-harness detail, not part of the go2rtc source string — without it ffmpeg eats
the rest of a heredoc. go2rtc manages the child's stdin itself.

**Option B — ✅ BUILT. `src/rtsp/tunnel-relay.ts`, and ffmpeg is out of the media path entirely.**

A TCP listener per camera presents it as ordinary RTSP, so go2rtc uses its **native** client, native
H.264 passthrough and in-process HKSV muxing, with no ffmpeg child at all:

```
go2rtc --plain RTSP/TCP--> relay --RTSP-over-HTTPS tunnel--> camera
```

Client bytes are base64'd onto the tunnel's POST channel; the GET channel (RTSP responses *and*
interleaved RTP) is copied back verbatim. ✅ **Measured against the real pinned go2rtc and a real
camera: 61.9 s of continuous 1920×1080 H.264, 17.3 MB through go2rtc's own muxer, `0` ffmpeg
processes.** Enabled per camera with a `localRtsp` block; see `docs/SETUP.md`.

🔑 **The relay holds NO camera credentials, by design.** It is a byte relay, so the camera's Digest
challenge passes through untouched and go2rtc authenticates end to end — which means an unauthorized
caller reaching a relay port gets the camera's own 401. The camera credentials therefore live in
`config/go2rtc.yaml` (already a mode-600 secret) and never in `config.yaml` or the
credential-holding bridge container.
⚠️ **This is also why the request URI must never be rewritten** — Digest signs it. That rules out one
port routing several cameras by path, and is the reason each camera gets its own listener.

Five things this had to get right; each cost a real failure:

- 🔑 **Base64 each write SEPARATELY, padding and all** — that is the QuickTime scheme, and LIVE555
  resyncs on `=`. Buffering to a 3-byte boundary to avoid mid-stream padding **deadlocks**: the tail
  of a request is held back and the server never sees the end of it. It hides, too — `OPTIONS`
  happened to be 3-byte aligned and succeeded, `DESCRIBE` did not and hung forever. Guarded by a
  regression test that was mutation-checked; the buffering version fails 4 tests, and 8 still pass.
- 🔴 **Never pass an IP as TLS SNI.** Node throws outright ("Setting the TLS ServerName to an IP
  address is not permitted"), and a camera address is always an IP — so every tunnel failed at
  connect time while the unit suite stayed green, because the tests inject a plain-TCP connect and
  never reach the TLS path. ⚠️ **A test seam that bypasses the real transport cannot see a bug in the
  real transport.** There is now a test that drives the production `connect` deliberately.
- 🔴 **The open-timeout callback must not touch a socket declared below it.** The first version did,
  so when the timer won the race — an unreachable camera, exactly what the timeout is *for* — it
  threw a `ReferenceError` out of a timer callback, where nothing can catch it. Under
  `restart: unless-stopped` one offline camera would have crash-looped the bridge.
- **LIVE555 ignores the host in the RTSP request URI**, which is why a client may address
  `rtsp://<relay-host>:<port>/s1` and still reach the right stream. It keys on the path only.
- **The `Content-Base: rtsp://0.0.0.0/s1/` quirk is harmless** — clients then send
  `SETUP rtsp://0.0.0.0/s1/track1` and the camera accepts it. Only a client that tries to *connect*
  to that address breaks.
- 🔴 **`CameraManager.start()` throws on an empty list, and a fully-local deployment produces one.**
  That guard predates local RTSP — when WebRTC was the only transport, "no cameras" could only mean
  a misconfigured `config.yaml`. It crash-looped the bridge on the first real deployment, **after
  all three relays had come up healthy**, so the logs read as success right up to the fatal.
  ⚠️ `index.test.ts` mocks `CameraManager` with a `start` that resolves, so the suite stayed green —
  the third time in this feature that a test double hid a bug in the thing it replaced. The fix is
  guarded by `index.transports.test.ts`, whose mock **throws on empty exactly as the real one does**.

⚠️ **The relay ports must be published by compose AND inside `ADC_BRIDGE_RTSP_PORTS`, and nothing
checks that they are.** go2rtc runs on `network_mode: host` and cannot reach the bridge's network
namespace. A `listenPort` configured but not published produces a stream go2rtc reports as offline
with no error logged anywhere — the bridge says it is listening, and it is, where nothing can reach it.

💡 Option B also retires a documented residual risk: no ffmpeg child means no go2rtc RTSP password in
a process argv (`SECURITY_AUDIT.md` → "go2rtc RTSP password in the bridge's process table").

### ✅ HKSV RECORDING IS PROVEN — and the trigger is an Alarm.com RULE, not the camera

Verified 2026-08-07. Triggering motion on go2rtc directly produced an **`hksv` consumer with
`protocol: "hds"`** (HomeKit Data Stream) alongside the `homekit` one — the home hub pulling
fragments to record. Live view, ingest, muxing and recording are all confirmed working.

```bash
# read-only: is motion currently asserted?
curl -s --user "$GO2RTC_API_USERNAME:$GO2RTC_API_PASSWORD" \
  "http://<bind>:1984/api/homekit/motion?id=<stream>"
# trigger / clear it (POST = on, DELETE = off) — this is exactly what the bridge does
curl -X POST   ... "http://<bind>:1984/api/homekit/motion?id=<stream>"
curl -X DELETE ... "http://<bind>:1984/api/homekit/motion?id=<stream>"
```

🔴 **What does NOT work is the trigger, and it is not our bug.** Walking in front of a camera
produced no motion event. `parseMotionEvent` reads a **`ruleName`** — Alarm.com emits motion events
from a configured **notification RULE**, not from the camera detecting motion. No rule, no event, and
nothing on our side can compensate.
⚠️ **The socket is NOT idle** — `messagesReceived` climbed within 60s of connecting, with the events
classified as `unhandledEvents`. An earlier reading of "delivering nothing" was inferred from the
absence of `Motion detected` log lines, which only proves no MOTION arrived. That distinction is the
whole reason `events.messagesReceived` exists: **connected + traffic + zero motion** points at the
rule, whereas connected + zero traffic would point at the subscription.
➡️ Fix on the Alarm.com/Brinks side: enable video motion detection **and** attach a notification rule.

⚠️ **`[hksv] flush fragment` is logged at DEBUG** (`pkg/hksv/consumer.go`), and go2rtc runs at `info`,
so a *successful* recording logs absolutely nothing. Do not read silence as failure — check the
consumer list instead.

🔎 **The 240-second reconnect cycle in the bridge's event log is BY DESIGN** —
`TOKEN_REFRESH_MS = 240_000`, a proactive refresh before the WebSocket auth token expires. The gap is
~1 second. It looks alarming in a log and is not a fault.

🔑 **`connected: true` is not evidence that events flow.** The status endpoint now reports
`events.messagesReceived`, which is the field that separates "Alarm.com is sending nothing" from
"events arrive but none are motion" — a distinction that previously required `sudo docker-compose
logs` and cost a session to make.

### 🔴 ONE duplicate YAML key anywhere in `go2rtc.yaml` silently disables EVERY config write

Measured 2026-08-07, and it cost a camera's HomeKit pairing.

`app.PatchConfig` is read-modify-write over the WHOLE file, and `yaml.Patch` unmarshals it to read it
**and** unmarshals its own output to validate. `yaml.v3` rejects duplicate keys at **any** nesting
level. So a single duplicate — even in a section that has nothing to do with what is being saved —
makes every persisted write fail: HomeKit `pairings`, `device_id`, `device_private`, stream edits.

⚠️ **go2rtc otherwise runs completely normally.** The only signal is
`WRN error="yaml: unmarshal errors: … already defined at line N"` at a log level nobody is watching.

🔑 **The failure surfaces much later, and looks like something else.** A pairing created during that
window lives in memory and works perfectly — go2rtc calls `savePairings()` only at the instant a pair
is added and never retries — so it vanishes on the next restart. Removing the accessory in the Home
app then leaves memory and disk disagreeing: go2rtc keeps advertising `sf=0` ("already paired"), the
Home app attempts pair-**verify** with credentials it no longer has, and the add hangs on
**"Connecting…"** forever, never reaching pair-setup. The QR is irrelevant at that point.

➡️ **Recovery:** confirm the pairing is absent from `go2rtc.yaml`, then `docker-compose restart
go2rtc`. It reloads from disk, the accessory comes up genuinely unpaired (`sf=1`), and pairing works.
⚠️ Restarting is only safe once the OTHER accessories' pairings are confirmed on disk.

🔎 **Diagnostics, no sudo needed:**
```bash
dns-sd -L "<Accessory Name>" _hap._tcp local     # want sf=1 to pair, sf=0 = already paired
npm run verify:config -- <deployment-root>       # strict-parses go2rtc.yaml, blocks on duplicates
```
✅ `npm run verify:config` now strict-parses for exactly this. ⚠️ A regex over top-level keys is NOT
enough — the duplicate can be nested.

💡 `PatchConfig` calls `os.WriteFile(path, b, 0644)`. Go preserves the mode when truncating an
existing file, so mode 600 survives — verified after a real pairing write. It would only land 0644 if
the file were ever recreated rather than overwritten.

### ⚠️ What the local-RTSP spike did NOT prove — this is the adoption backlog

The things that made the spike cheap are exactly the production constraints it removed:

- **The endpoints came from a saved capture, not from live code.** They live on `mobile.alarm.com`,
  a different API from the `www.alarm.com/web/api/…` surface this bridge speaks. Nothing in `src/`
  can fetch them. That client is the single largest piece of adoption work.
- ⚠️ **Endpoint stability, PARTLY settled 2026-08-07 — and the two halves behave differently.**
  - 🔑 **The PORT survived an IP change.** A camera moved to a new address the same day and kept its
    per-camera port exactly, so the port is **device-assigned, not derived from the DHCP lease** —
    despite looking UPnP-ish (sequential, one per camera, mirrored onto `PublicRtspEndpoint`).
  - **The IP does drift**, and drifted within hours of the capture. Now pinned by DHCP reservation,
    which is a fix outside this repo and invisible to it.
  - ❓ **Still untested: whether the port survives a CAMERA REBOOT.** A lease change is not a reboot.
    This is the one remaining unknown that decides whether a `mobile.alarm.com` client is needed at
    all, and it costs one power-cycle to answer.
  ⚠️ **A camera at a stale address presents as a hang, not a refusal** — TCP times out and `ffprobe`
  sits there. Find it by MAC from the capture in `arp -an` after a ping sweep, or scan the subnet for
  the port; the stale ARP entry for the OLD address survives and will point you at the wrong host.
- **Credential rotation is untested.** The per-camera `Login`/`Password` are unrelated to
  `CameraSessionToken` (which does carry an expiry), but nothing establishes that they are durable.
- ✅ **RESOLVED — the relay is built** (`src/rtsp/tunnel-relay.ts`, Option A/B section above), so
  "go2rtc cannot pull the tunnel" and "no bridge code changed" no longer apply.
- 🔴 **Every camera is a SEPARATE HomeKit accessory with its own PIN, and pairing is manual.**
  go2rtc holds its own pairing state (`device_id`, `device_private`, `pairings` in
  `config/go2rtc.yaml`) — nothing is inherited from Homebridge, and nothing is inherited from an
  existing go2rtc accessory either. Going from the one paired camera to three means **two new
  accessories added by hand in the Home app**. ⚠️ Lose or overwrite `config/go2rtc.yaml` and every
  pairing goes with it.
- **Lifecycle is still thin** — the relay has connection bounds, an open timeout and an idle timeout,
  but there is no circuit breaker and no media watchdog on the local path.
- **HKSV recording is still unproven** (backlog item 4) — only ingest was demonstrated here.
- **TLS is unauthenticated in practice**: self-signed `CN=www.alarm.com`, expired Dec 2024. ffmpeg
  does not verify by default, which is why this works; anything that turns verification on breaks it.
- 🔴 **`PublicRtspEndpoint` exposes these same ports on the WAN address.** Digest-auth RTSP over an
  expired self-signed cert, reachable from the internet, almost certainly via UPnP. Not probed from
  outside. Worth a deliberate decision rather than an inherited default.

### 🔑 `endToEndWebrtcConnectionInfo: null` does NOT mean Alarm.com dropped end-to-end WebRTC

Proxy is their documented **failure fallback** (3-min timeout, no audio), so that `null` means
*"Direct has been failing for this camera"* — it clears when connectivity is fixed.

⚠️ **Do not build the Janus proxy path in response to this symptom.** Full reasoning, sources, and
why upstream `Omar-L#2`'s "older camera models" framing is incomplete: `Journal.md` 2026-08-03.

### ⚠️ `supportsAudio: false` is NOT a proxy indicator on this account

It sits inside `proxyWebrtcConnectionInfo`, which makes it look like a property of the proxy path
(Alarm.com's KB does say Proxy carries no audio). But **none of the cameras on this account have
microphones**, so the field reads `false` on any transport. It cannot distinguish them.
Offered as a test on 2026-08-06 and withdrawn. The 3-minute `proxyStreamTimeoutTime: 180` is the
only usable proxy signature — nothing camera-side ends a stream at exactly 180s.

### ❓ OPEN: which transport the Brinks MOBILE APP uses is UNCONFIRMED

The web player is settled — it gets `endToEndWebrtcConnectionInfo: null` and times out at 3 minutes
(measured 2026-08-06, from their own client). The **app** streamed past 4 minutes with no visible
interruption, which is *suggestive* of a different transport and **is not evidence**:

🔴 **"No stutter observed" does not distinguish the two hypotheses.** Mobile players buffer 2–3
seconds, so a proxy session that silently re-establishes at 180s is **invisible however carefully
you watch**. An unobserved event and a non-event look identical from outside.

Standing judgement (not a measurement): **probably proxy with a seamless reconnect.** A better
reconnect UX in a phone app than in a web player is an ordinary asymmetry; Alarm.com deliberately
granting Direct to one of its own first-party clients and withholding it from the other is not.

⚠️ Do not spend more time on this from our side — every remaining discriminator is either invisible
(the app's traffic is behind probable certificate pinning) or smaller than a playback buffer.
➡️ It is a question **for Brinks**, answerable from their logs: *"your web player times out at 3
minutes while your app streams continuously — different transports, or does the app re-establish
silently?"*
🔑 It does not affect the case either way. *App on proxy too* ⇒ no client gets Direct.
*App on Direct* ⇒ their app gets Direct and their own website does not. Both are valid complaints,
and the web-player artifact stands independently of both.

### 🔎 Reading the status endpoint — three fields that are routinely misread

Measured 2026-08-06, each of these cost time in one session:

- **Every failure count and cooldown is named for its own breaker**: `streamFailures` /
  `streamNextProbeInMs` and `tokenFailures` / `tokenNextProbeInMs`.
  ⚠️ **Fixed 2026-08-06 — you need this to decode anything captured BEFORE that.** Older payloads,
  logs and notes carry a bare `consecutiveFailures` / `nextProbeInMs` sourced from the **stream**
  breaker alone. So in an old capture, `tokenCircuit: open` beside `nextProbeInMs: 0` is neither a
  contradiction nor "probing right now": the stream breaker was closed and idle *because* no tokens
  ever arrived, and the token breaker's real cooldown — up to an hour — was not in the payload at all.
- **`lastError` is written only when `stream.start()` throws, and is NEVER cleared.** So an absent
  `lastError` does not mean healthy — it means the process restarted, or nothing was ever attempted.
  Used deliberately, it is a reliable **restart detector**.
- **`state: 'connecting'` that does not move is a REPORT OF SUCCESS, not of progress.**
  `connect()` resolves at `SESSION_STARTED`, not on media, and `_state` becomes `'streaming'` only in
  `onTrackReady`. A session that starts and never delivers a track therefore sits at `'connecting'`
  forever *and* is recorded as a success by the stream breaker. See the handoff backlog — there is no
  media watchdog yet.

### ✅ Smoke-test the whole downstream half without a camera — synthetic RTSP into go2rtc

Verified end to end 2026-08-06. Publishes colour bars into the real `front` stream, so it exercises
**exactly** the path the bridge uses. Needs no Alarm.com, no camera, and touches no config.

```bash
ssh kaikoura 'cd /volume1/docker/adc-video-bridge && set -a && . ./.env && set +a && \
  /var/packages/ffmpeg7/target/bin/ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "smptebars=size=1920x1080:rate=10" -an \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v main -pix_fmt yuv420p -g 20 -b:v 2M \
  -t 1200 -f rtsp -rtsp_transport tcp \
  "rtsp://$GO2RTC_RTSP_USERNAME:$GO2RTC_RTSP_PASSWORD@192.168.7.42:8554/front"'
```

⚠️ `/usr/bin/ffmpeg` is 4.1.9 and has **no RTSP muxer**. Use `/var/packages/ffmpeg7/…` (7.1.5).

🔑 **Read the result from `/api/streams`, and know which consumer is which** — this distinction is
the whole test:

| consumer | means |
|---|---|
| `fmt=keyframe` | a **snapshot** for the camera tile. Proves HAP pairing and the accessory work. |
| `fmt=homekit proto=rtp medias=3` | a **live SRTP session**. This is the one that proves live view. |

Seeing only `keyframe` is *not* a pass — the tile can render while live view is broken, which is the
shape Phase 2's `srtp.listen` landmine took. Tapping the tile is not enough; the Home app must be
opened **full-screen** to negotiate RTP.

⚠️ **Check the PRODUCER too, not just consumers.** `consumers: 0` reads as "HomeKit is not attached"
when the real story can be that the source died. Measured 2026-08-06: ten confusing minutes spent
reading a dead publisher as a HomeKit failure.

### 🔴 On Kaikoura, HOLD the ssh connection for long runs — do NOT `setsid`/`nohup` detach

Measured across three runs 2026-08-06. Two that kept the ssh session attached ran their full window
(5 min, 18 min). The one launched with `setsid nohup … &` **died after ~5 minutes with an empty log
and a clean exit**, despite `-t 1500`. `nohup` only blocks `SIGHUP`; DSM appears to tear the process
group down by other means when the session is reaped.

➡️ Run long jobs as a foreground command over ssh and let the caller hold the connection. The
canonical detach incantation is the one that fails here, which is why this is worth writing down.

### 🔴 `node` on Kaikoura is NOT on a non-interactive ssh PATH — use the full path

`ssh kaikoura 'node dist/probe.js …'` fails with `No such file or directory`, which reads as "node
is not installed on the NAS". It is: `/usr/local/bin/node` (plus DSM's `Node.js_v20` / `v22`
packages). Always use the absolute path from a non-interactive shell.

⚠️ Related, same host: this Synology has **Compose v1**. `docker compose` does not exist —
it is `docker-compose`, or address the container directly (`container_name: adc-video-bridge`).
And the host `dist/` is **stale by design** — the Dockerfile builds inside the image — so it is
never evidence about what the container runs. Check the container:
`sudo docker exec adc-video-bridge ls dist/utils/table.js`.

### 🔴 A missing e2e block is NOT retried, and must not be made to retry

`fetchVideoTokenSilent()` wraps the fetch in `retry({ maxAttempts: 3 })`. That budget covers
**thrown** errors only — `retry()` does `return await fn()`, so a `null` return is a *successful*
return and comes straight back after **one** call. The line reads like it retries the
no-WebRTC-block case three times. It does not.

**This is correct, not a bug.** A missing `endToEndWebrtcConnectionInfo` is a persistent platform
state ("Direct has been failing for this camera"), not a transient fault, so the right response is
the escalating breaker cooldown — which is exactly what happens.

⚠️ **Measured 2026-08-06**, one login then four `liveVideoHighestResSources` calls 15s apart against
the live camera: **every call returned no block** (`errorEnum: 0`, only `proxyWebrtcConnectionInfo`
in `included[]`). Retrying does not recover this state. Making null go through `retry()` would
triple the call rate on an account Alarm.com may already have demoted, and `retry()`'s 1s/2s backoff
is far too fast to wake anything even in principle.

🔑 Do not confuse this with the **dial-in wake ladder** in `CameraStream.start()`. That handles
`Camera <id> has not yet dialed in` — a *signaling* failure that occurs **after** a token with a
valid e2e block was obtained. Different condition, different layer; that ladder works and does run.
Conflating the two is what made this look like a missing-retry bug in the first place.

### Do not re-diagnose "stream dies after ~37s"

Fixed. A stale FFmpeg `exit` callback cleared the **replacement** child's reference. Two halves must
both survive any refactor — `stop()` detaches ownership *before* `SIGTERM`, and the `exit` handler
ignores the event unless the exiting child is still the owned child. Two regression tests cover it.

---

## Session lifecycle

### 🔑 Every session callback must be gated on ownership

`camera-stream.ts` has now produced the same object-lifecycle bug **three times**: the stale ffmpeg
`exit` callback, the placeholder track, and a discarded `pending` whose late RTP re-entered
`cutOver` and forced a dead pipeline back to `'streaming'`.

Any new callback on a `PeerSession` asks *"is the object that fired this still the one I own?"*
first — see the identity gate on RTP forwarding and on `onTrackReady`.

---

## Circuit breaker

### 🔑 Do not "simplify" it to count exceptions

Its failure predicate is **"produced no usable result"**, not "threw". `token-manager.ts` records a
failure on the branch where Alarm.com returns HTTP 200 with no WebRTC block, which does **not**
throw and does **not** emit `error`. That branch is the entire point; a breaker keyed on `catch`
sleeps through the outage it was built for. Reasoning: `Journal.md` 2026-08-03 and 2026-08-04.

### 🔑 The credit in `camera-manager.ts`'s reconnect branch needs BOTH conditions

Do not collapse it to one. It requires that we **still own the start guard**
(`activeStarts.get(id) === startId`) **and** that the stream is **not dead** (`'streaming'` **or**
`'connecting'`). Neither implies the other:

- **Ownership** stops a *stale* attempt crediting after a newer one took over.
- **Liveness** stops an attempt that still owns the guard crediting a stream that died in flight.

`'connecting'` counts as alive **deliberately** — the `activeDied` fallback awaits `tryConnect()`,
which resolves on `'sessionStarted'` while `onTrackReady` has not yet flipped `_state` to
`'streaming'`. Requiring `'streaming'` records neither success nor failure on a real recovery.

⚠️ A review parked this as a "known one-line fix" (swap state for ownership). **That swap is wrong
and regresses `'does not credit a torn-down stream when reconnect() resolves after it'`.** Reasoning:
`Journal.md` 2026-08-04 (later).

### ⚠️ Thresholds are coupled to the ladders next to them, and one is deliberately off by one

`STREAM_FAILURE_THRESHOLD` is `BACKOFF_STEPS_MS.length + 1` so the ladder's 10-minute cap is used
once before the circuit opens; setting it equal to the length makes that rung dead code.

`TokenManager`'s 600 s `setInterval` must stay **unconditional** — it is the backstop that restarts
the camera recovery chain after a suppressed fetch, and gating it on circuit state would make an
open token circuit permanent.

---

## Deployment and Homebridge

- The documented npm audit exception is limited to **GHSA-2p57-rm9w-gvfp** and is guarded by a check
  that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the **maintained scoped** camera package, not the stale unscoped npm package.
- Use the normal Homebridge UI login to install the plugin. **Do not mint or reuse internal UI
  tokens** to bypass authentication.
- Ports **8554** and **1984** are authenticated but unencrypted on the LAN; bind only to the
  intended host address and do not forward them.
- Homebridge `config.json` is mode 600, with a pre-camera mode-600 backup at
  `config.json.bak-adc-camera-20260801-191305`.
- If Synology reports package start failure while the Homebridge user manager has no D-Bus socket:
  verify Homebridge itself in a bounded foreground run, then recreate only that stale session with
  `sudo loginctl terminate-user homebridge` before starting the package normally.

---

## 🔴 BLOCKER: go2rtc API auth and HomeKit pairing are mutually exclusive

**Measured 2026-08-04 on the deployed fork (`1.9.14+dev.506cfa7`).** Pairing fails; the Home app
retries for ~a minute and gives up.

The HAP accessory is served on the **API port** — `internal/homekit/homekit.go` passes
`Port: uint16(api.Port)` — and `internal/api/api.go`'s `middlewareAuth` has **no path exemption**.
So HomeKit's pairing requests hit Basic auth and are rejected:

```
POST /pair-setup   -> 401
POST /pair-verify  -> 401
POST /accessories  -> 401
```

HomeKit speaks HAP, not HTTP Basic, and cannot authenticate. **With go2rtc API auth enabled at all,
native HomeKit pairing cannot work.** ⚠️ `local_auth` is NOT the deciding factor — an iPhone is
never on loopback, so the LAN path is blocked either way.

✅ **FIXED LOCALLY 2026-08-04 by `patches/go2rtc-hap-auth-exempt.patch`**, applied in
`Dockerfile.go2rtc` on top of the pinned commit. It exempts **only** `/pair-setup` and
`/pair-verify` from the Basic-auth middleware — neither is left unprotected (pair-setup is guarded
by the setup PIN via SRP, pair-verify by the long-term keys), and everything afterwards runs inside
the encrypted HAP connection `pkg/hksv` hijacks from the `ResponseWriter`, so it never re-enters
that mux. Verified: applies cleanly to a fresh checkout at `506cfa7d` and `go build ./...` is clean.
⚠️ The build uses plain `git apply` — **not** `-3` or `--reject` — so a patch that stops applying
FAILS the build loudly instead of silently producing an unpatched binary. That is the whole point of
pinning. 🔴 Report this upstream on #2130 and delete the patch when it lands there.
✅ **REPORTED 2026-08-08, and INDEPENDENTLY IMPLEMENTED 2026-08-23** in `Mo3he/go2rtc@6f76ea9a`
on a branch that is our pin plus 25 commits and 0 behind. Verified 2026-08-25: this patch no
longer applies against it, and his version is better (registers `hap.PathPairSetup` /
`PathPairVerify` through a new `api.HandleFuncNoAuth` rather than hardcoding the strings).
✅ **DONE 2026-08-25: the build moved to `Mo3he/go2rtc@2464e567` and the patch is DELETED.**
The exemption now lives in the pinned source, so there is nothing to apply.
🔴 **Do not re-add a local patch, and do not "tidy away" the exemption if you meet it upstream** —
the defect it fixes is silent and late, and this section exists so the reasoning survives the
patch it used to describe.

**Do not "fix" this by disabling go2rtc's API auth.** That would leave the snapshot/stream API
unauthenticated to every device on the LAN — for a security camera — and it breaks the compose
healthcheck, which asserts a 401. The options are: patch the fork so HAP paths bypass the auth
middleware (this looks like a real defect in PR #2130 and is worth reporting there); run a second,
auth-less go2rtc dedicated to HomeKit; or keep Homebridge serving HomeKit.

✅ **One risk retired while diagnosing:** `Store: &go2rtcPairingStore{}` **is** wired in the fork, so
the spec's "pairings may be lost on every restart" concern does not apply. go2rtc also writes
`device_id` and `device_private` back into `go2rtc.yaml` as designed — observed directly.

🔑 **Config schema correction:** the key is `homekit:` keyed by stream name with `hksv: true` nested
under it — **not** a top-level `hksv:` block as earlier docs said. Go's YAML ignores unknown keys, so
the wrong spelling starts cleanly and advertises nothing, which looks exactly like "HomeKit shows no
accessory to pair."

## 🔴 `srtp.listen` must NOT be empty once `homekit:` is configured

**Measured 2026-08-04.** The accessory pairs successfully and looks entirely healthy, then shows
**"No Response"** in the Home app and never sends video.

`internal/srtp` returns early when `listen` is empty, leaving `srtp.Server` **nil**, and
`internal/homekit`'s `streamHandler` refuses every stream with `homekit: can't work without SRTP
server`. Nothing in the Home app hints at the cause. Set it to a bound address —
`"${GO2RTC_BIND}:8443"` (`:8443` is the module's own default) — never `""`.

⚠️ This was flagged during the Phase 0 final review as a "Phase-2 landmine", recorded only in the
SDD ledger, and **lost when that gitignored worktree was deleted at merge**. It then cost a real
debugging cycle. 🔑 **A finding that lives only in scratch state does not survive the merge that
ends the work — move it into the repo before deleting the workspace.**

## Standing decision: native HKSV via go2rtc

**Spiked and measured 2026-08-03. Verdict: track, adopt when it ships.** Recorded here so it is not
re-litigated from scratch.

HKSV **recording does not re-encode**: 0.7% CPU, ~22 MB RSS, **zero ffmpeg**, muxing fMP4
in-process.

⚠️ Do **not** repeat the earlier argument that `vcodec: "copy"` makes this pointless — `vcodec`
governs *live view*, not HKSV recording. Costs are unchanged
([go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is unmerged and unreleased → self-build,
losing the by-digest pin), but the benefit is now established rather than speculative.

🔴 **Adoption is not a swap — the spike ran on the HOST, not in Docker, which is why it was easy.**
HomeKit needs mDNS on the real LAN and Docker bridge networking does not forward multicast, so a
containerised HKSV go2rtc needs `network_mode: host`, `macvlan`, or an mDNS reflector. Host
networking costs **only** the network-namespace control — read-only rootfs, `cap_drop: ALL`,
`no-new-privileges`, non-root and digest pinning all survive it.

✅ **Prerequisite done (Phase 0, 2026-08-04): go2rtc is split into its own container.** It was
previously fused into the bridge image (`alexxit/go2rtc` as the runtime base, started by
`entrypoint.sh`), which would have put the ADC-credential-holding bridge on host networking too.
Now only the go2rtc container runs `network_mode: host`; the bridge keeps its own network namespace
on the default Docker network and holds the Alarm.com credentials there. HKSV itself is still **not
enabled** — no `hksv:` block, `srtp:` still disabled.

🔴 **Revert trigger: when go2rtc#2130 merges and ships in an official release, delete the build
stage in `Dockerfile.go2rtc` and go back to the official digest-pinned `alexxit/go2rtc` image.** The
self-build (toolchain pinned by digest, source pinned to a commit SHA on the `hksv` branch — see
`docs/SECURITY_AUDIT.md`) is justified only by HKSV being unreleased. Without deleting the stage
when the PR ships, the self-build outlives its justification and keeps carrying a maintenance and
audit cost the official image no longer requires.

Spike method, gotchas, and what stayed unmeasured: `Journal.md` 2026-08-03.
🧹 Spike fully torn down; production untouched. Delete any leftover **"HKSV Spike"** accessory from
the Home app.
