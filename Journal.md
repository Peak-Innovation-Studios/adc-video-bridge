# Journal

Narrative history: **why** things are the way they are. Live state lives in
`docs/AGENT_HANDOFF.md` — if the two disagree, the baton wins.

Read the most recent entry; `grep` for older ones. When this file gets long, move older entries
to `docs/journal/` unedited and leave a pointer here — do **not** start a new log file.

---

## 2026-08-07 (later) — The spike lands: live 1080p off all three cameras, no cloud

**Claude Code (Opus 5).** The morning's entry ended with local RTSP "reachable, credentialed, and
unproven". It is now proven. All three cameras — including both ADC-V515s that `SupportsWebRTC:
false` puts permanently beyond this bridge — deliver live 1920×1080 H.264 with **stock ffmpeg, no
custom code, no Alarm.com call, no video token, no WebRTC**.

### The whole answer

```bash
ffprobe -rtsp_transport https -i "rtsp://<user>:<pass>@<lan-ip>:<port>/s1"
```

The standing hypothesis — RTSP tunnelled over HTTP, QuickTime scheme — was right. Confirming it took
one header: `GET /s1` with `Accept: application/x-rtsp-tunnelled` returns `200 Content-Type:
application/x-rtsp-tunnelled` where the same `GET /s1` without it returns 404. Through that tunnel
the port is an unremarkable LIVE555 RTSP server: `OPTIONS` → 200 with the full method set,
`DESCRIBE` → 401 `Digest realm="RTSP Server"` → 200 and an SDP.

### The trap that made ffmpeg look like it could not do this

ffmpeg *could* do it the whole time. `ffprobe -rtsp_transport https -i rtsps://…` fails with **`404
Stream Not Found`**, which reads unmistakably like a wrong path — I had already burned probes on
`/s0`, `/live`, `/h264`, `/stream1`. It is not a path problem. `rtsps://` makes ffmpeg write
`OPTIONS rtsps://…/s1` into the RTSP *request line*, and LIVE555 cannot parse that scheme into a
stream name. Give ffmpeg `rtsp://` and put the TLS in the transport flag and it connects.

🔑 **The URL scheme and the transport had to disagree.** Nothing in the error said so; a trace of
what ffmpeg actually put on the wire did, in one line.

### Two of yesterday's readings of this port were wrong, in the same shape

- *"`GET /s1` returns 404, so the path is not an HTTP resource."* It returns 404 only without the
  tunnel's own `Accept` header — the one thing that makes the request mean anything.
- *"404 rather than 401, so the credentials were accepted."* `GET /` returns **200** with no auth at
  all. This server issues 404s without consulting credentials, so that response carried no
  information about them.

Both are the same error: **a probe that omits the protocol's handshake produces a response about the
probe, and I read it as a response about the target.** It is the near neighbour of the trap this
repo already documents one layer up — *"did not produce a usable result" is the failure, not
"threw"* — and I did not recognise it because the probe returned a clean, confident HTTP status.

### How far it was carried

Not just a `DESCRIBE`. 6-second `-c copy` captures off all three cameras (real varying imagery —
mean luma 90–125 with frame-to-frame motion, not a black or frozen frame); then the same pull run
**from Kaikoura** on ffmpeg 7.1.5 and pushed into the live go2rtc `front` stream, which registered
the producer as `video, recvonly, H264`. That lands it on the downstream half already verified end
to end on 2026-08-06. Nothing downstream has to work for the first time.

### What this does not mean

It is a spike, and the things that made it cheap are the production constraints it removed: the
endpoints came from a saved capture, not from live code, and they live on `mobile.alarm.com` — an
API `src/` cannot call. Endpoint and credential stability are both untested; the ports look
UPnP-assigned. No lifecycle, no reconnect, no watchdog, no bridge code changed. The full list is in
`docs/INVARIANTS.md` → "What the local-RTSP spike did NOT prove", and that list *is* the adoption
backlog.

⚠️ One finding that is not about video: `PublicRtspEndpoint` publishes these same per-camera ports on
the WAN address — digest-auth RTSP behind a self-signed certificate that expired in Dec 2024,
reachable from the internet, almost certainly created by UPnP. Not probed from outside. It deserves
a decision rather than continued inheritance.

The Brinks defect is unchanged and still real. It is simply no longer in the critical path.

---

## 2026-08-07 — The founding premise is wrong: these cameras have local RTSP

**Claude Code (Opus 5).** David ran Proxyman against the Brinks iOS app. What came back reframes the
whole project, and retires two days of diagnosis as having been aimed at the wrong layer.

### The mobile app uses a different API, and it hands out local RTSP endpoints

The app does not use `www.alarm.com/web/api/…` at all. It talks to **`mobile.alarm.com`** — a legacy
RPC-over-HTTP surface where every call is a form POST with an `Action` parameter
(`GetLiveVideoStream`, `GetAllSirenDevices`, `GetWebsocketAuthToken`, …), returning XML or JSON.

Its camera-list response carries, **per camera**:

```
LocalRtspEndpoint      rtsp://<user>:<pass>@<lan-ip>:<port>/s1
PublicRtspEndpoint     rtsp://<user>:<pass>@<wan-ip>:<port>/s1
VpnRtspEndpoint        rtsp://<user>:<pass>@videostreamna02.alarm.com:8090/s1
Login / Password       per-camera credentials
SupportsRtspStreaming  true
DirectConnectionMayWork true
```

And the app's own telemetry (posted to `adc-vid-rstats.devicetask.com`) says what it actually did:

```
protocolType     "RTSP"        connectionType "DIRECT"
isWebRTCFallback false         errorType      "NONE"
```

🔑 **`README.md` opens by asserting cameras "cannot be accessed directly via RTSP — ADC re-provisions
camera credentials via OpenVPN and randomly generates root passwords."** Every architectural choice
in this repo descends from that sentence: WebRTC, the signalling client, werift, the 600s token
refresh, three circuit breakers. **It is wrong** — or rather, it was true of the *web* API, which is
all the browser integration we ported from could see. The design inherited that horizon.

### The detail that changes the roadmap regardless

| camera | model | `SupportsWebRTC` |
|---|---|---|
| doorbell | ADC-V723 | `true` |
| indoor A | ADC-V515 | **`false`** |
| indoor B | ADC-V515 | **`false`** |

**The two indoor cameras cannot do WebRTC at all.** This bridge could never have served them — not
today, not after Brinks fix anything. For those models local RTSP is not a nicer path, it is the
only one.

### What is NOT established — this is a spike, not a fix

The local port is reachable from the NAS and the credentials are accepted, but **it is not plain
RTSP**:

- TCP connects, then silence to a plaintext `OPTIONS` — it is waiting for a TLS handshake.
- It **is** TLS: self-signed `CN=www.alarm.com`, expired Dec 2024.
- RTSP inside the TLS tunnel returns **`HTTP/1.1 400 Bad Request — Bad request: [OPTIONS]`**. So the
  listener is an HTTP server, not RTSP.
- `GET /s1` over TLS with Basic auth returns **404, not 401** — credentials accepted, path not an
  HTTP resource.
- `rtsp://` and `rtsps://` both fail in ffprobe with `Invalid data found`.

Reading: probably **RTSP tunnelled over HTTP** (the QuickTime scheme — `GET` with `x-sessioncookie`
plus a `POST` reverse channel). Unproven. That is the next piece of work, and it is real work.

### 🔑 Three of my own conclusions died today, and the pattern is the same one

- *"The app streaming proves e2e WebRTC works somewhere"* — no. The app was not using WebRTC at all.
- *"`rlyviduscc` = the Relayed tier"* — no. It serves `GetSavedClipThumbnail.ashx`. I inferred a
  protocol tier from three letters of a hostname.
- *"The mobile API issues e2e credentials the web API withholds"* — true, but I read it as the app's
  transport when the app never used those tokens; they exist for its *fallback* path.

Each was me explaining the app's behaviour using the only mechanism I had modelled. **The app had a
capability that was not in my model, so every explanation built from that model was wrong in the same
direction.** The fix was not better reasoning about WebRTC — it was one capture showing what the app
actually does.

### Where it ends

Video is still down and the Brinks complaint still stands: their **web** API returns
`endToEndWebrtcConnectionInfo: null` while their **mobile** API mints signalling tokens for the same
camera. That is a real defect on their side.

But it is no longer the only route. Local RTSP is reachable, credentialed, and the only possible path
for two of the three cameras. ⚠️ No credentials, MAC addresses, IP addresses, tokens or camera names
from those captures appear in this repo, and they must not.

---

## 2026-08-06 (later) — Two new cameras answered in a minute what a day of probing could not

**Claude Code (Opus 5).** David pushed back: *"we had the video working with the spike, it's not the
camera, why can't we get video this new way?"* Right to push. The answer took two experiments, a
correction to something I had asserted, and then — decisively — a fact that had nothing to do with
any of it.

### The decisive evidence, and it was not any of my tests

David connected two indoor cameras and they failed identically. One login, one videoSource call per
camera:

| name | model | e2e | proxy | errorEnum |
|---|---|---|---|---|
| doorbell | ADC-V723 | **null** | set | 0 |
| indoor A | ADC-V515 | **null** | set | 0 |
| indoor B | ADC-V515 | **null** | set | 0 |

**3 of 3, two models, and two of them connected that day.** The bridge is configured for one camera
and has never contacted the other two. No mechanism we control reaches them.
⚠️ **Alarm.com's own web player was also failing at the time — RETRACTED as evidence, see below.**

🔑 **The evidence that settled it came from widening the population, not from deepening the
analysis.** Everything I did — a wake-probe, a cold probe, reading the token path, the status
endpoint — examined one camera harder. Two cameras that had never met our code answered the question
in under a minute. When a hypothesis is "X caused this", the cheapest disproof is usually an instance
of the symptom that X could not have touched, and that is a question about *scope*, not about depth.

### The two experiments, which were right and were still not enough

Both were aimed at "could our code have caused this?", and both came back negative:

1. **Wake-probe.** One login, four `liveVideoHighestResSources` calls 15s apart. `README` says that
   call is what wakes the camera, so if retrying could recover the state, the block would have
   appeared. It did not, on any call.
2. **Cold probe.** The bridge stopped completely for ~55 minutes, then a single probe. Still no
   block. That ruled out our retry cadence and our session-holding.

⚠️ But the cold probe had a stated residual I could not close: *a platform penalty with a horizon
longer than an hour*. Fifty-five minutes cannot disprove a multi-day demotion that our earlier
retrying might have triggered. The new cameras closed it instantly — a penalty cannot reach a device
that was not on the account.

### A defect I reported, then had to narrow

I found that `retry()` re-attempts only on a **throw**: `return await fn()` means a `null` return is
a *successful* return, so a response with no e2e block gets exactly one call and then waits 600s. I
reported that as "the wake ladder never runs".

That conflated two failure modes. The wake ladder in `CameraStream.start()` handles
`Camera <id> has not yet dialed in` — a **signaling** failure that happens *after* a token with a
valid e2e block was obtained. A missing block is a different condition at a different layer, and
that ladder does run when it applies.

So the real defect was smaller and entirely about what the code *claims*: `maxAttempts: 3` sitting
above a null-check reads as though the important failure is retried three times. **The behaviour was
correct — a missing block is a persistent platform state, and the escalating breaker cooldown is the
right response.** Fixing it by routing null through `retry()` would have tripled our call rate on an
account that may already have been degraded, for a state I had *measured* retries do not recover.
Recorded at the call site and in `INVARIANTS.md` instead.

### How the app actually gets video

Worth knowing, and it kills the "camera is offline" reading outright:

```
janusGatewayUrl        = wss://adcwebrtcproxy-na02.devicetask.com:8989/janus
proxyStreamTimeoutTime = 180        supportsAudio = false
proxyWebrtcConnectionInfo = SET     endToEndWebrtcConnectionInfo = null
```

The app never talks to the camera. It pulls from a media relay in Alarm.com's cloud that the camera
pushes into. So the cameras are **online and reaching Alarm.com** — they are simply being served the
documented failure fallback (3-minute sessions, no audio) while Direct is not provisioned at all.
⚠️ Per `INVARIANTS.md` the janus fields are present *always*; the signal is the **pair** — proxy set
**and** e2e null.

### 🔑 The corroborating evidence was measuring David's Safari settings

`INVARIANTS.md` carries a rule: *if Alarm.com's own web player and phone app disagree, suspect the
**network path**, because two first-party clients differing cannot be explained by any server-side
theory.* The app streamed while the website failed for every camera, so I chased that — established
the app works on cellular **and on the failing website's own WiFi**, declared the network eliminated,
and wrote the app/website split into the baton as supporting evidence.

**All of that was an artifact.** David found the cause: Safari's **iCloud Private Relay** ("Hide IP
address → from Trackers and Websites"). Toggling it off, the videos load. A masked IP breaks WebRTC
generally, so the web player had been failing for an entirely local reason that had nothing to do
with Alarm.com.

Had it reached the technician session, it is precisely the detail that gets a report dismissed —
their engineer sees Private Relay in the console and stops reading.

**It does not transfer to the bridge, and I measured rather than assumed.** The NAS and the Mac
egress from the *same* public IP (via the LAN gateway; Tailscale installed but not
carrying traffic), and a re-probe with the website playing still returned **e2e null on all three
cameras**. So the bridge is not on a masked path, and its failure is not the website's failure.

The network elimination survives, but on better reasoning that needs no second client: **the bridge
receives a valid, authenticated HTTP 200 with `errorEnum: 0` and one field omitted.** A network fault
does not produce a well-formed JSON response missing exactly one key.

🔑 **The lesson is about corroboration, not about Private Relay.** I had one instrument that never
touched a browser — an authenticated API call from a headless box — and one that ran inside a
consumer browser with privacy features, extensions and a content blocker. I treated agreement
between them as strengthening the case. It was not: the second instrument had a failure mode the
first could not have, so it could agree for reasons of its own. **Corroboration from a noisier
instrument is not corroboration.** Ask what could make the confirming observation true *by itself*
before counting it.

That check — *"does the website also fail in a clean browser?"* — is what found Private Relay. It was
raised as a formality to stop a technician dismissing the report on a stray extension, and it
overturned the evidence instead. **A caveat worth raising is worth actually running**; this one took
two minutes and removed a false pillar from the case.

🔑 **Considered inspecting the mobile app's API calls to explain the split, and did not.** It would
need mitmproxy plus a CA on the phone, and Alarm.com very likely pins certificates, so the likely
outcome is an hour of setup and no data. The cheaper instrument was the *failing* client: browser
devtools on their website needs no tooling at all. **When two clients disagree, instrument the one
that is broken — it is where the error detail lives, and it is usually the one you already control.**

### 🔑 The strongest evidence came last, from their own client

With the retraction made, the obvious question was still open: does Alarm.com serve **us** a
different answer than it serves a browser? If their web player got an e2e block and our API client
did not, the complaint changes entirely — from "your platform is broken" to "you are treating our
client differently".

David logged into alarm.com in the in-app browser and pressed play. Their own player calls the
**same endpoint we do** and receives the **same response**:

```
GET /web/api/video/videoSources/liveVideoHighestResSources/<id>
  HTTP 200   errorEnum: 0
  includedTypes: ["proxyWebrtcConnectionInfo"]
  endToEndWebrtcConnectionInfo: null
```

It then played over the Janus proxy and, three minutes later, produced their own UI message:
**"The stream has timed out. Please press play to continue playback."** — matching
`proxyStreamTimeoutTime: 180` exactly. The predicted timeout, from the predicted transport,
announced by their own client.

🔑 **What makes this the best artifact of the investigation is that it is a SUCCESS, not a failure.**
Everything else we had was something not working, and anything not working invites *"what is wrong
with your setup?"* — which is precisely how Private Relay nearly derailed the report. A `HTTP 200`
from their own first-party client, carrying a null field and falling back to their documented
3-minute proxy, cannot be attributed to our code, our network, or a browser setting. Their client,
their API, their fallback, their timeout message.

It also repairs the retraction with something stronger than the claim that was pulled: not *"their
web player fails too"* (it does not fail — it plays), but *"their web player is offered the same
degraded transport we are."*

⚠️ Note the sequencing. The browser could only be used as an instrument **after** Private Relay was
found and turned off. The contaminated instrument, cleaned, produced the decisive measurement — so
the right response to a noisy instrument is to clean it, not to discard it.

### ⚠️ Two of my own diagnostic guards failed silently, in the same shape

Both were background watchers, and both printed a confident conclusion having measured nothing:

- A precheck used `curl -s -w '%{http_code}' … || echo "000"`. On a refused connection curl prints
  `000` **and** exits non-zero, so the fallback ran too and the variable held `000000`. The equality
  test failed and it reported "bridge is STILL RUNNING" about a bridge that was stopped.
- A consumer-watcher's parse step returned nothing, so neither exit branch could fire; it timed out
  and printed *"No consumer seen"* with `live=` and `consumers=` **empty**. That is what a watcher
  which never took a reading prints — not evidence.

🔑 **A command that emits output on its failure path defeats `cmd || fallback`**, because both run
and the results concatenate. `%{http_code}` always prints, which is exactly what makes it unsafe as
a guard; the exit code was the real signal, sitting right there. More generally: I armed both
watchers without once running their guard against a known state. *Test that the check can fail* is
in `lessons/verification.md`; what I skipped is the cheaper half — **run it once against a state
whose answer you already know.**

### Where it ends

Downstream is **half-verified**: a synthetic SMPTE-bars stream published into go2rtc was accepted and
parsed (`medias=1`), so RTSP ingest is healthy. HAP/SRTP/HKSV is still unverified — the Home app was
never opened during either window, and the watcher meant to catch it was the broken one above.

Brinks are scheduling a **virtual technician session**. The evidence to put in front of them is the
3-of-3 table plus `errorEnum: 0` with a null e2e block, which says their service reports success
while omitting the configuration.

---

## 2026-08-06 — The blocker moved, and the status endpoint reported "calm" the whole way

**Claude Code (Opus 5).** "The video still isn't coming through." It still isn't — but it is failing
**differently** than it was the night before, and the baton's wording ("the camera never dials in")
had become wrong in the specific way that would misdirect a support call. Three distinct states were
measured in one day. The endpoint built to make this diagnosable reported an all-clear through two
of them.

### Three states in one day, and only the middle one is load-bearing

| # | `state` | `tokenCircuit` | `lastError` | What it proves |
|---|---|---|---|---|
| 1 | `idle` | closed, 3 fails | `has not yet dialed in` | e2e config WAS issued; sessions attempted and refused |
| 2 | `connecting` (frozen) | **open** | none | config issued, `connect()` **resolved**, no media ever followed |
| 3 | `idle` | closed, 0 fails | none | **no e2e config at all** — nothing is even attempted |

State 3 is fully accounted for: `probe.js` returns `endToEndWebrtcConnectionInfo: data: null` with
`errorEnum: 0` and login succeeding, while `proxyWebrtcConnectionInfo` stays populated — confirmed
twice, an hour apart. With no config, `handleVideoToken` never fires, `stream.start()` never runs,
and the stream sits at `idle` recording nothing. go2rtc agrees: the `front` stream has no producer.

**State 2 is the finding.** It can be produced exactly one way. `fails=0` with no `lastError` proves
`start()` never threw; `connecting` proves `tryConnect()` ran. A rejecting `connect()` would have
shown `idle` between ladder retries and then `error` + a populated `lastError` within ~3 minutes, and
we watched far longer than that seeing only `connecting`. **So the camera dialed in, completed
`SESSION_STARTED`, and then sent no video.** That is a strictly later failure than "never dials in",
and it holds under either code version, so the deploy state does not weaken it.

Per `INVARIANTS.md`, a null `endToEndWebrtcConnectionInfo` means *"Direct has been failing for this
camera"* and clears when connectivity is fixed. So the arc across the day is Alarm.com progressively
giving up on Direct for this camera — not a protocol change, and still not our code.

### 🔑 Two defects that let a dead stream look calm

Both were found by asking why the endpoint looked healthy while nothing worked, and both are the same
trap `README.md` already documents **one layer up** — that the breaker must treat *"did not produce a
usable result"* as the failure rather than *"threw"*, because ADC answers an unreachable camera with
HTTP 200 and simply omits the block. That lesson was never carried downward:

1. **No media watchdog after `SESSION_STARTED`.** `connect()` resolves on session start, not on
   media, and `_state` becomes `'streaming'` only in `onTrackReady`. A session that starts and never
   delivers a track is therefore recorded as a **success** — `breaker.recordSuccess()` runs — so the
   stream breaker is *reset by the very failure it exists to catch*, and the stream sits at
   `'connecting'` indefinitely.
2. **A camera that is never attempted reports `idle` with zero errors.** `lastError` is written only
   when `start()` throws; when ADC issues no config, `start()` is never called. The most serious
   state the system can be in produces the calmest output it can emit, for ~30 minutes until the
   token breaker opens (threshold 3 × a 600s refresh).

🔑 **The generalisable form: a status field that is only written on a thrown error cannot report the
failures that do not throw** — and those are the ones this integration actually has. "Nothing is
wrong" and "nothing is happening" rendered identically.

### The hypothesis I had to kill before the real answer appeared

I first theorised that `PeerSession.connect()` could hang unbounded, which would have explained a
frozen `connecting` neatly. It was wrong: `signaling-client.ts` has a 30s timeout, and — the detail
that decides it — that timeout is cleared on `SESSION_STARTED`, **not** on `HELLO`, so the whole
handshake is properly bounded. Had it been cleared on `HELLO`, the wait for `SESSION_STARTED` would
have been unbounded and the hang would have been real.

Killing that hypothesis is what produced the answer, because ruling out "still connecting" left only
"connected, and no media" — which is a much more specific and more useful thing to tell Brinks.
**The wrong hypothesis was not wasted work; being precise about why it was wrong is what narrowed
it.** Cost: reading two functions.

Method note worth keeping: I committed to a falsifiable prediction — with
`VIDEO_TOKEN_FAILURE_THRESHOLD = 3` and a 600s refresh, `tokenCircuit` should open ~20–30 min after
a restart while `state` stays `idle`. Stating the number that would break the model is cheap, and it
is the difference between a diagnosis and a story that fits.

### A restart is not a rebuild, and the host `dist/` cannot tell you which happened

The bridge was restarted to pick up the day's commits, which does **not** deploy new code — the
container keeps the image it was built from. When I went to verify, the obvious check misled: the
host's `dist/` was a day old, which looks like proof that nothing was rebuilt. It is not evidence at
all — `Dockerfile` builds *inside* the image, so the host `dist/` is stale by design even after a
correct rebuild. Only the container can answer:
`sudo docker exec adc-video-bridge ls dist/utils/table.js` (a file only the current code has). It
came back present: the rebuild took.

⚠️ Two host facts cost time and are now in `INVARIANTS.md`: this Synology has **Compose v1**
(`docker compose` does not exist), and `node` is installed but **not on a non-interactive `ssh`
PATH**, so `ssh kaikoura 'node …'` fails with `No such file or directory` — which reads as a
statement about the host and is actually a statement about the shell. That is the same error shape
`INVARIANTS.md` already names for ADC's payload: **reading a field as a claim about the camera when
it is a claim about the plumbing.** Third occurrence of that shape in this project.

### Where it ends

Current code is deployed and verified in the container; build clean, 16 files / 236 tests, audit
passing. Nothing in the day's commits touches signaling, tokens or media, so none of them is
implicated in the outage.

Still a Brinks/Alarm.com call, with sharper wording than yesterday's: *Alarm.com returns
`endToEndWebrtcConnectionInfo: null` for this camera while proxy config stays populated; earlier the
same field was populated, and in the one window where a session did establish, the camera completed
signaling and delivered no video.*

---

## 2026-08-05 — Cleared the deferred nits, and a push that lied about happening

**Claude Code (Opus 5).** A quiet session by design: the camera still has not dialed in, so
everything downstream of video stayed blocked and the work was the two backlog items that were not.
Both are done. The findings worth keeping are one tooling trap and one recurring documentation
failure — neither of which was the task.

### 🔑 `git push` reported "Everything up-to-date" for a push that had just succeeded

Pushing the docs commit left over from the 2026-08-04 handoff, `git push origin main` printed
`Everything up-to-date` for a branch that was demonstrably 1 ahead. I nearly reported that an
earlier session had already pushed it. GitHub's activity API records the push landing at
`04:09:19Z` with that exact SHA — it was mine, and it worked.

The output passes through the RTK proxy, which rewrites `git …` and compresses what comes back.
In the same batch a `dotfiles` push rendered its real `e2ec35b..26aaa18` line, so **the corruption
is intermittent**, which is the dangerous kind: the output is right often enough to be believed.

What makes this worth a journal entry rather than a shrug is which local check *cannot* catch it.
`git reflog show origin/<branch>` logs `update by push` both when your push sent the commits **and**
when it merely caught a stale tracking ref up to somebody else's — identical text, opposite
meanings. It agreed with whichever story I brought to it. Only `git ls-remote` (what is actually
there) and the activity API (who put it there, when) can distinguish the two.

Generalised and filed in `~/.claude/lessons/verification.md`: for any proxied or summarised command,
verify the **effect** on the system, never the report of the effect. Same shape as the `wrangler`
lesson already sitting two rows above it — deployed the wrong Worker, reported success.

### Two of the four "nits" were real bugs, and both only bite during recovery

The list read as trivia. Two of the four were not:

- **`rtpCount` was never reset on a cutover.** `stop()` was the only reset, and make-before-break
  deliberately never calls it — that is the entire point of the design. So the counter ran on from
  the retired session, and the `RTP packets sent to ffmpeg` line, which fires at info level only at
  packets 1 and 100, never fired again for the life of the process. That line is the evidence media
  actually resumed on the new session, so the cost was precisely the signal a cutover needs.
- **`tryConnect()` left `_state` at `'connecting'` when `connect()` rejected.** Invisible from
  `start()`, which corrects it in its own catch. But `reconnect()`'s fallback path calls
  `tryConnect()` **directly**, with no such catch — so a rejection there stranded the stream
  advertising a negotiation nothing was driving, and `reconnect()` then refused to run ever again
  because it requires `'streaming'`. A stuck stream, reported as busy.

Both are only reachable while recovering from another failure, which is why neither showed up in
normal operation. The pattern is now familiar in this codebase: **the happy path is well covered
and the recovery paths are where the defects live.** Reading callers found these; exercising the
entry point would not have.

The RED step earned its keep on the first one. The failing test read `expected 4813 to be 1` — not
`4812`. That digit is the proof: the counter had been incremented *past* the stale value, so the
cutover genuinely inherited the old session's count rather than merely leaving a field unset. A test
written after the fix would have shown a green tick and proved neither.

The other two were as advertised: an unreachable `'fallback'` member of `OverlapOutcome`, and a
comment claiming `activeDied` "cannot be true" on the cutover path. The guard proves that only at
the instant `cutOver` settles — the newly promoted session can fail in the turn between that
`resolve` and the read. Harmless, since both branches are guarded on `result === 'kept'`, but the
comment asserted a stronger invariant than the code has.

`src/discover.ts` was the simplest and had a second defect hiding behind the reported one:
`console.log('%-20s', v)` does not merely fail to pad — `util.format` has no width or flag syntax at
all, so the specifier was emitted verbatim and the values appended after the whole format string.
Replacing it with a tested `src/utils/table.ts` exposed the separator rule as `'-'.repeat(70)` under
a 69-character header; it is now derived from the column widths.

### The review that recorded these nits is gone, and this is the second time

A `grep` across `Journal.md` and `docs/` found only the baton's own one-line summary. "A false
comment near `cutOver`" is enough to know something is wrong and not enough to know *what* — I had
to re-derive the finding and can only say which comment I judged false, not which one the reviewer
did.

⚠️ **This is the same failure as Phase 2's SRTP landmine**, which was flagged in a Phase 0 review and
recorded only in an SDD ledger inside a gitignored worktree deleted at merge (see
[`docs/journal/2026-08-04.md`](docs/journal/2026-08-04.md), the 2026-08-04
Phases 1 & 2 entry). Different mechanism, identical outcome: **the verdict survived and the
reasoning did not.** A deferred finding costs a session to re-derive later, so it must carry enough
of its own evidence to be actionable cold — a summary that only a reader who already knows the
answer can decode is not a record.

### What I did not do

`onFailed` fires on `'disconnected'` as well as `'failed'` (`peer-session.ts:235`), so a transient
ICE blip forces a full teardown. `'disconnected'` is the recoverable WebRTC state and `'failed'` the
terminal one, so the *shape* of the fix is not in doubt — debounce, act only if it has not
recovered. The timeout is a tuning value, and choosing one with no camera to tune against would be
guessing dressed as a fix. Left in the baton, marked blocked, with that reasoning attached rather
than a bare "TODO" — see the section above for why.

### Where it ends

Build clean, **16 files / 236 tests** (up from 15 / 229), audit passing. `main` is `81718bd` and
pushed. Kaikoura still runs `656baed`, and this commit touches `src/`, so it needs a hand rebuild to
land — no urgency, since none of these four fixes affect the dial-in that is blocking video.

The blocker is where it was: the camera streams in the Brinks app and never dials in to the
end-to-end WebRTC signaling server. Still a support call, not a code change.


---

## Older entries — archived, not deleted

Moved out of this file on 2026-08-06, **unedited**. `grep -rn` finds them here just as well:

- [`docs/journal/2026-08-04.md`](docs/journal/2026-08-04.md) — Phases 1 & 2 (the split deployed,
  native HKSV shipped, the crash-loop); *"Didn't this work in the spike?"*; native HKSV Phase 0 and
  its nine defects; make-before-break and the parked "one-line fix"; the ADC API circuit breaker.
- [`docs/journal/2026-08-03.md`](docs/journal/2026-08-03.md) — the "no video" outage that was poor
  WiFi; measured performance findings; the native-HKSV spike; the first upstream contributions.

🔴 **New entries go at the TOP of this file, never in the archive.**
