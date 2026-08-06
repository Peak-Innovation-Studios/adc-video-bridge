# Journal

Narrative history: **why** things are the way they are. Live state lives in
`docs/AGENT_HANDOFF.md` — if the two disagree, the baton wins.

Read the most recent entry; `grep` for older ones. When this file gets long, move older entries
to `docs/journal/` unedited and leave a pointer here — do **not** start a new log file.

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
recorded only in an SDD ledger inside a gitignored worktree deleted at merge (see the 2026-08-04
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

## 2026-08-04 (Phases 1 & 2) — Deployed the split, shipped native HKSV, and crash-looped the bridge

**Claude Code (Opus 5).** Phase 1 (deploy the split) and Phase 2 (native HomeKit) both landed. The
accessory pairs, pairing persists, SRTP is up, motion works end to end. **There is still no video,
and the cause is the camera** — unchanged all day and now well evidenced.

### Four blockers, each hidden behind the one in front of it

Every layer was independently correct; each failure only became visible once its predecessor was
cleared. That is the shape worth remembering.

1. **HomeKit could not pair.** HAP is served on the **API port** (`Port: uint16(api.Port)`) and
   go2rtc's `middlewareAuth` has **no path exemption**, so `/pair-setup` returned 401 — which HAP
   structurally cannot satisfy. API auth and native HomeKit were mutually exclusive. Fixed by
   `patches/go2rtc-hap-auth-exempt.patch`, exempting only `/pair-setup` and `/pair-verify`; both
   carry their own cryptography, and everything after pair-verify runs inside the encrypted HAP
   connection `pkg/hksv` hijacks, so it never re-enters that mux.
2. **Paired, then "No Response".** `srtp: listen: ""` left `srtp.Server` nil and `streamHandler`
   refuses every stream with `can't work without SRTP server`. The accessory looks perfectly healthy
   and never sends a frame. ⚠️ This was flagged in the Phase 0 final review as a "Phase-2 landmine"
   and recorded **only in the SDD ledger — which lives in a gitignored worktree deleted at merge.**
   It cost a debugging cycle to rediscover.
3. **Recording would never have fired.** `motion: api` needs something to call
   `POST /api/homekit/motion?id=<stream>` with Basic auth. The bridge's webhook builds
   `${motionUrl}/motion?<name>` with no credentials — three mismatches. Also: the whole motion block
   was gated on `homebridge.motionUrl`, so it would have **stopped running entirely** at cutover.
4. **No video.** The camera. Unchanged.

### 🔑 I crash-looped production, and the lesson is about half-fixes

Building a status endpoint (so diagnosing the bridge would stop needing sudo), I set
`bindAddress` to the host's LAN address — but the bridge runs on the **default bridge network**,
where that address does not exist. I had imported a rule from go2rtc, which is on host networking
with no port mapping and therefore genuinely must bind explicitly. The bridge is the opposite case:
`0.0.0.0` is correct precisely *because* compose's `ports:` mapping confines the host side.

Worse: the validation **threw from the constructor**, `main()` treated it as fatal, and
`restart: unless-stopped` restarted it into the same failure. For ~16 minutes the bridge was not
attempting the camera at all while appearing to run.

I had already written the right principle — *a diagnostics endpoint must never take down the thing
it reports on* — put it in a comment, and tested it. Then implemented it for **one** of the two ways
it can fail: I reasoned about `listen()`, which fails asynchronously, and never considered the
synchronous constructor. **Stating a principle and enforcing it at one call site feel like the same
act and are not.** The fix that holds is `startStatusServer()`, where the guarantee lives in a single
function that cannot be bypassed.

### What the endpoint bought, and it was worth the scar

`GET :9090` now returns per-camera state, both circuit states, consecutive failures, next-probe
time, and the last error with its age — camera **names only, never IDs**, asserted by a test. That
turned "is the camera dialing in?" from a sudo round-trip into a two-second query, which is what
finally made the evidence conclusive: a **fresh process, clean circuit, zero backoff** still gets
`has not yet dialed in` while the Brinks app streams the camera fine.

### Where it ends

Combined with Alarm.com's **own web player** failing earlier, the evidence says end-to-end WebRTC is
unavailable for every client while proxy streaming works. That is a Brinks/Alarm.com support
conversation, and the wording that gets past first-line is: *the camera streams in the app but never
dials in to the e2e WebRTC signaling server.*

---

## 2026-08-04 (Phase 2) — "Didn't this work in the spike?" — yes, and why that did not transfer

**Claude Code (Opus 5).** Worth writing down because it is the obvious question, the answer is
"yes", and the reason it did not carry over is structural rather than a regression.

| | Spike (2026-08-03) | Phase 2 (2026-08-04) |
|---|---|---|
| Where it ran | **Host process**, spare ports 1985/8555 | Container, `network_mode: host` |
| go2rtc API auth | **None** — throwaway config | `api.username` set → HAP got **401** |
| Video source | **Consumed production's working RTSP** | Bridge publishes; camera will not dial in |
| Result | Paired, recorded, measured | Pairs (after a patch), no video |

### The two things the spike skipped are the two things that blocked Phase 2

**API authentication.** A hand-run go2rtc on spare ports had no `api.username`, so `middlewareAuth`
was never installed and HAP sailed straight through. Production has auth, HAP is served on the API
port, and the middleware has no path exemption — so `/pair-setup` returned 401 and the Home app
failed to add the accessory with no diagnostic. That is not a regression from the spike; it is a
condition the spike never exercised. `patches/go2rtc-hap-auth-exempt.patch` is what lets both exist
at once, which the spike never had to reconcile.

**The camera session.** The spike consumed the RTSP stream production was *already publishing* — it
needed no camera session of its own, and the camera was healthy that day. In Phase 2, go2rtc **is**
production, the bridge publishes into it, and the camera has not dialed in. The spike sat downstream
of the problem we now have.

Also skipped, and separately expensive: the container's read-only rootfs versus go2rtc persisting
pairing keys into its own config, and `srtp.listen` — which a minimal spike config left at its
default and the hardened one had explicitly disabled as "unused".

### 🔑 The generalisable lesson

**The things that make a spike cheap are exactly the constraints production imposes.** No container,
no auth, no deployment change, consume an existing stream — every one of those is a production
requirement removed. So a spike is strong evidence about the **feature** and no evidence at all
about the **integration**.

The spike's findings all still hold and are still the reason to do this: HKSV recording does not
re-encode, 0.7% CPU, ~22 MB RSS, zero ffmpeg. Every blocker since has come from integration, not
from the feature.

⚠️ The standing decision **did** call part of this — *"Adoption is not a swap — the spike ran on the
HOST, not in Docker, which is why it was easy"* — but it flagged only mDNS. The same "run it bare"
choice also skipped authentication, the camera path, the read-only filesystem, and SRTP. **When a
spike is deliberately unrepresentative, enumerate everything it skipped, not just the part that
looks hardest at the time.**

---

## 2026-08-04 (later still) — Native HKSV Phase 0: splitting go2rtc out, and nine defects the reviews caught

**Claude Code (Opus 5).** Merged as 14 commits. Phase 0 only — **nothing is deployed and HKSV is
not enabled**. This makes the bridge able to talk to a go2rtc in a *different container*, which is
the prerequisite the 2026-08-03 spike identified: HomeKit needs mDNS multicast, so go2rtc must run
on `network_mode: host`, and the container holding the Alarm.com credentials must not follow it
there.

### The thing that made this expensive was invisible in the design

The spec and the plan both said "split the containers." Neither noticed that **the split breaks
authentication in three places at once**. `Go2rtcApi` sent no credentials; the RTSP push URL carried
none; the compose healthcheck curled `127.0.0.1` unauthenticated. All three worked only because the
two processes shared a container and **go2rtc exempts loopback from auth**. Move go2rtc one
namespace away and every one of them 401s.

That was found while *writing the plan*, not while designing — which is the argument for writing
plans in enough detail to be wrong in.

### Nine defects, and where they were caught

| Caught by | Defect |
|---|---|
| Implementer | `golang:1.23-alpine` too old — `go.mod` at the pinned commit needs `go 1.24.0` |
| Implementer | `./cmd/go2rtc` does not exist at that commit; `main.go` is at the module root |
| Implementer | ffmpeg's **own stderr** prints the credentialed URL, logged as `{ffmpeg: line}` |
| Task review | No `ffmpeg.on('error')` — an uncaught exception's `err.spawnargs` leaks the argv |
| Task review | `GO2RTC_BIND` injected and consumed **nowhere** — bound all interfaces |
| Final review | CI smoke-tested `command -v go2rtc` **inside the bridge image**, which no longer has it |
| Final review | The deleted `entrypoint.sh` credential guards were never re-homed |
| Final review | Healthcheck deadlocks on the shipped default (loopback returns 200, not 401) |
| Re-review | The bridge's `apiUrl` pointed at its own container loopback post-split |

Two were build failures that would only have surfaced on the NAS. Four were mine, in the plan.

### 🔑 The worst one, and why it is worth writing down

Task 4 deleted `entrypoint.sh`'s four `: "${GO2RTC_*:?}"` guards. My stated justification was that
`loadConfig()` validates those credentials. **It does not** — `validateConfig()` checks `rtspPort`,
`apiUrl`, log level, cameras and Homebridge, and nothing about go2rtc's credentials. And go2rtc
installs its auth middleware only `if cfg.Mod.Username != ""`.

So empty credentials would have produced an **unauthenticated go2rtc API, web UI, snapshot endpoint
and RTSP** — LAN-bound, with compose `ports:` no longer confining anything because host networking
ignores it. The single-container version refused to start in that state. Fixed with compose
`${VAR:?...}`, which errors on empty as well as unset.

**The general shape: deleting a guard is safe only if you verify the thing you claim replaced it
actually does.** I asserted the replacement existed instead of grepping for it.

### Three defects were the same defect

`GO2RTC_BIND`, the bridge's `apiUrl`, and `.env.example`'s comment were all places where **the split
changed what an address must be**, written when one container was the whole world. None lived in
code — they were config, examples and comments, where no test and no type-checker reaches. A suite
at 213 passing tests has exactly zero power over any of them.

### What a specified-but-unowned constraint looks like

The plan's Global Constraints said, prominently: *"`listen:` must be an explicit address, never
`:1984`."* Every task passed its own review. No task implemented it. Per-task review asks "does this
meet its brief?" and never "does some task own this constraint?" — so a headline requirement can be
stated clearly, reviewed against, and land nowhere. The final review found a second instance
(`.github/workflows/ci.yml`) by being told to hunt for one.

### Method notes worth keeping

- **Every new test was falsified by reverting its own fix.** That is what makes 194→213 mean
  something; an untested redaction hook passes just as green as a working one.
- The final reviewer verified three load-bearing claims **against the pinned go2rtc source** rather
  than the fixer's summary: that `--version` exits before `initConfig`, that compose `:?` errors on
  empty, and that `local_auth: true` makes the 401 hold on loopback. Two of my own assumptions were
  wrong elsewhere in this session; that habit is why this one shipped.

### The residuals, and the one that turned out to be two halves of one fact

Five items were parked at merge because the workflow allows a single fix wave. All five were closed
immediately afterwards.

🔑 **The two "important" ones were the same fact seen from opposite ends.** `ADC_BRIDGE_BIND_ADDRESS`
was the last required variable still defaulted (`${VAR:-127.0.0.1}`), and the security record claimed
Basic auth covered every RTSP request *"loopback included (`local_auth: true`)"*. Verified against the
pinned commit, that claim is false — `internal/rtsp/rtsp.go` reads

```go
// skip check auth for localhost
if conf.Mod.Username != "" && !conn.RemoteAddr().(*net.TCPAddr).IP.IsLoopback() {
```

and there is **no `local_auth` key under `rtsp:` at all**. `local_auth` governs the API module only.
RTSP *is* fully authenticated in practice — but solely because `listen:` is the LAN address, so
nothing arrives over loopback.

Which means the security guarantee rested entirely on the variable that defaulted to the value
breaking it. ⚠️ And `local_auth: true` had **removed the accident that used to catch a missing bind
address**: previously the loopback probe returned 200 and failed the health gate loudly; afterwards
it returns 401 at any address, so go2rtc would report **healthy while bound where nothing can reach
it** and every stream would fail silently. Fixing either alone would have left a live hole.

The corrected wording now names *where* each endpoint's protection comes from, rather than asserting
that it holds — a claim that names its mechanism can be re-checked against that mechanism later.

The other three were quick: the CI timeout raised to 30 minutes (it now compiles go2rtc from source),
a stale review date, and a `statSync().isFile()` guard so Docker's directory-at-a-missing-bind-mount
names its own cause instead of a bare `EISDIR`.

---

## 2026-08-04 (later) — Make-before-break, and a parked "one-line fix" that wasn't

**Claude Code (Opus 5).** Merged to `main` as a 12-commit branch. Closes the ~1.2s media gap
filed upstream as `Omar-L#25`.

The shape is what the plan intended: `reconnect()` builds the replacement `PeerSession` **alongside**
the live one and cuts over on its **first RTP packet**, rather than closing the old PeerConnection
first. Break-before-make survives only as the fallback, for when the overlap fails or the active
session dies mid-flight. `PeerSession` was extracted out of `CameraStream` to make "two sessions at
once" expressible at all — the old code could not represent the state.

**The gap is real and current, not historical.** Production logs mid-branch measured
reconnect→first RTP at **~1.08s**, which is what the whole exercise is aimed at. Live view never
noticed it (the RTSP publisher never drops — ffmpeg spawns once in 30 minutes); it is HKSV
recording that will care.

### The thing actually worth writing down: a parked fix was a hypothesis, not a conclusion

The final whole-branch review returned "Ship with fixes." The fix wave landed them, and re-review
found one more hole, which was **parked with an explicit ruling**: the breaker records neither
success nor failure on the `activeDied` fallback path, because that path awaits `tryConnect()`,
which resolves on `'sessionStarted'` while `_state` is still `'connecting'` — only `onTrackReady`
flips it to `'streaming'`. The ruling was right about the defect, right that it was non-blocking,
and named the mechanism correctly. It also stated **"THE FIX IS KNOWN AND ONE LINE"**: swap the
`state === 'streaming'` check for an ownership check on the `startId` stamp.

That swap is wrong, and it takes one command to find out. Applying it fails
`'does not credit a torn-down stream when reconnect() resolves after it'` — a test **the same fix
wave had just added**. That test reproduces a tear-down *without* handing the guard to a newer
attempt, so the stale attempt still owns it and would falsely credit; the circuit closes on a dead
stream (`'error'` instead of `'error (circuit open)'`).

🔑 **The two guards defend disjoint failure modes, and neither implies the other.** Ownership stops
a *stale* attempt crediting after a newer one took over. Liveness stops an attempt that *still owns
the guard* crediting a stream that died in flight. The real defect was never "wrong guard" — it was
that `=== 'streaming'` is too **strict**, excluding the legitimately-recovering `'connecting'`
state. So the fix requires **both** conditions, and admits `'connecting'` as alive. Dead and unknown
states default to no credit: a missed credit is bounded (the next clean cutover clears the
counters), a false credit hides an outage.

The generalisable lesson, and it is not specific to this repo: **a finding parked with a proposed
fix carries two claims — that the defect is real, and that the fix is correct. Reviews are good at
the first and unreliable at the second**, because the proposer reasons about the bug in isolation
while the regression tests that would contradict them were written to defend the *opposite* failure
mode. Try the proposed fix and watch which test dies before believing it.

### The plan had a real bug in it, and the implementer caught it

Task 5's brief guarded the fallback on `result === 'kept' && !activeDied`, which lets a **successful
cutover** fall through into `tryConnect()` and tear down a perfectly healthy stream. The implementer
found it, the reviewer confirmed it. Worth noting because it is the second time on this branch the
*plan's own sample code* contradicted the plan's prose (Task 4's `discardPending()` never settled the
outcome promise, hanging `reconnect()` forever, while the text promised it "cannot hang forever").
Where the two disagree, the prose is the design and the sample is a defect.

### The same object-lifecycle bug class showed up a third time

Task 3's review caught `stop()`/`tryConnect()` never tearing down `pending`, so a stale pending's
late RTP re-entered `cutOver` and forced a dead pipeline back to `'streaming'`. This file has now
produced that shape three times (the stale-ffmpeg-`exit` callback, the placeholder track, this).
The recurring fix is the same: **gate every callback on "is the object that fired this still the
one I own?"** — hence the identity gate on RTP forwarding and the ownership gate on `onTrackReady`.

### ⚠️ An agent worktree under `.claude/worktrees/` doubles the test count

Merging produced `24 files / 360 tests` — exactly twice the real figure. `vitest.config.ts` sets no
`include`/`exclude`, so the default glob walks the worktree's copy of `src/` too. Both copies passed
here, so it was only cosmetic, but the failure mode is not: **a stale worktree's failing tests fail
`main`'s suite**, and the failures point at files that look like the ones you are editing. After
`git worktree remove`, the honest number is `12 files / 180 tests`.

---

## 2026-08-04 — The ADC API circuit breaker, and four things the tests found

**Claude Code (Opus 5).**

Built the breaker deferred from 2026-08-03 (upstream `Omar-L#9`). The decisions recorded at the end
of that entry all survived contact with the code — scope all three loops, pause with an escalating
probe, self-heal, and key the failure on *"produced no usable result"* rather than *"threw"*. What
follows is only what was **learned by building it**; the rationale is in the previous entry and is
not repeated.

### The shape that fell out: a passive gate, not a scheduler

`utils/circuit-breaker.ts` owns **no timers**. Each loop already had its own `setTimeout` /
`setInterval` and cleared them in `stop()`; a breaker with its own timer would have added a fourth
thing to clear and a fourth way to leak one. Instead each loop asks `retryAfterMs()` when it
schedules its next attempt, and the clock is injectable so the state machine is testable without
fake timers at all.

One non-obvious consequence: `tryAttempt()` **consumes** the probe slot rather than merely
answering a question. Two callers can reach the same breaker at the same instant — the 600 s
refresh timer and the stream retry ladder both call `fetchVideoTokenSilent` for the same camera —
and a pure `shouldAttempt()` query would have let both through on one due probe.

### Four things found while writing the tests

1. 🔑 **Threshold = ladder length makes the ladder's last rung dead code.** With
   `STREAM_FAILURE_THRESHOLD = BACKOFF_STEPS_MS.length`, the failure that would have used the
   600 s rung is the same failure that opens the circuit, so the 10-minute cap is never the delay
   actually used. Fixed by `length + 1`; the ladder now saturates once before the circuit opens
   (~18 min). The existing "caps delay at 10 minutes" regression test is what surfaced it, by
   failing for a reason that was not the reason it was written for.

2. **The event listener's threshold lands exactly where a test asserted the old cap.** Five
   consecutive failures is the 5s/10s/30s/60s ladder plus one, so the assertion "failure 5 → still
   60s (capped)" became false the moment the breaker went in. That test was **rewritten, not
   deleted** — it now asserts the circuit opens there. Worth flagging in review: this is the one
   place where the change is visible as a *changed* expectation rather than a new one.

3. ⚠️ **The camera-manager gate is narrower than it looks, and that is fine.** `activeStarts`
   already suppresses concurrent starts, and the retry timer fires at precisely the moment the next
   probe becomes due — so the gate almost never denies anything on the ladder path. Its real value
   is elsewhere: it bounds **`handleUnexpectedExit`, which refetches immediately with no backoff of
   any kind**, and it makes the independent 600 s refresh path respect the circuit. The test is
   written against those two, because a test of the ladder path would have been asserting a
   coincidence.

4. **No deadlock, and it is worth knowing why.** The camera's recovery chain is *timer → fetch →
   emit → start → new timer*, and a suppressed fetch emits nothing, so the chain dies. What saves it
   is that `TokenManager`'s 600 s `setInterval` is unconditional and never stops ticking — it is the
   backstop, and the first probe that succeeds re-emits and restarts everything. Any future change
   that makes that interval conditional on circuit state would turn an open token circuit into a
   permanent one.

### Also worth carrying forward

- **`camera-stream`'s dial-in loop shares the token breaker** and can call it up to 12 times in a
  single start attempt, so the token circuit can open in ~40 s rather than over three 600 s polls.
  Intended — they are the same API call — but it means the threshold is not simply "three polls".
  A suppressed refetch returns `null` and the dial-in loop reuses its existing config, which it
  already handled (`if (fresh) currentConfig = fresh`).
- **A socket that opened and later dropped is not a circuit failure.** Only one that never reached
  `open` is. So a flapping event stream does not pause a loop that Alarm.com is plainly answering —
  flapping is a different fault from an outage, and conflating them would pause the wrong thing.
- **Thresholds and cooldowns are deliberately not configurable.** They are module constants, exported
  for tests. Adding config surface means validation, docs, and more for a reviewer to argue with;
  nothing yet suggests a deployment needs different numbers.
- `npm test` is now **11 files / 145 tests** (was 9 / 117). Build and `audit:prod` clean.

🔴 **Committed, not deployed.** Kaikoura still runs the previous image; `src/` changed, so it needs
`docker-compose up -d --build` and David's password. The breaker has never executed against the live
API — every claim above is from tests.

### Upstreamed as `Omar-L#32`, and the lockfile rule earned its keep

Cherry-picked onto `upstream/main` as `upstream-fix/circuit-breaker`. Only `src/index.ts` conflicted
(upstream has no `statusTimer` — that is ours, in `#29`); everything else auto-merged onto their
base, which is the useful signal that the breaker really is independent of the hardening.

🔑 **The "verify against UPSTREAM's lockfile" rule caught a real defect this time, not a phantom
one — and the trap is wider than the werift pin it was written for.** The token-manager fixtures used
`iceServers: []`. That passes *here* only because our hardening added an `Array.isArray` branch to
`fetchVideoSource`; **upstream `JSON.parse()`s the field directly**, and `JSON.parse([])` stringifies
to `""` and throws. So on their tree the fixture threw, `retry()` engaged with real 1s/2s delays the
fake timers never advanced, and **five tests hung until vitest's 5s timeout**. Verifying in our own
tree would have shipped a maintainer a test file that hangs.

Generalised: *any* fixture exercising code our hardening made more tolerant will pass here and fail
there. Recorded in the baton as a broadening of the existing rule.

The fix is also the better fixture on both trees — Alarm.com sends `iceServers` as a JSON **string**,
which is why upstream parses it at all. This is the `ws-token-123` lesson from 2026-08-03 running in
reverse: there a *tidy* fixture certified broken code; here a fixture written against the *local*
parser certified a test that could not run anywhere else. Backported to `main` as `e971299`.

Upstream's baseline is **9 files / 108 tests**; the branch takes it to **11 / 136**. The commit
message and PR body were rewritten for upstream — no internal dates, no fork-specific context, and
the four comments that named `2026-08-03` were reworded to stand on their own.

---

## 2026-08-03 — A "no video" outage that was poor WiFi, plus measured performance findings

**Claude Code (Opus 5), taking over from Codex.**

### The outage, and why the obvious reading was wrong

Symptom: no video. `/api/frame.jpeg` returned HTTP 200 with **0 bytes in ~1 ms**, three times
running. That single observation eliminated the whole right-hand side of the architecture —
go2rtc answered instantly because the stream was *declared*, and returned nothing because no
producer existed. The fault was upstream of go2rtc, and everything downstream was merely idle.

Tracing up: the ADC video-source call returned HTTP 200 with `errorEnum: 0` — a **success** — but
`relationships.endToEndWebrtcConnectionInfo.data == null`, with `proxyWebrtcConnectionInfo`
offered instead. `token-manager.ts` matches only the end-to-end type, so `fetchVideoSource`
returned `null` and the pipeline never started: zero `Allocated RTP port`, zero `Starting ffmpeg`.

**The wrong conclusion, and how convincing it was.** This looked exactly like a vendor transport
migration. Supporting it: a real API field had gone `null`; a documented alternative transport had
appeared in its place; upstream `Omar-L#2` described precisely that split by camera model; and
Alarm.com's own docs corroborated the proxy timeout and audio limits we were observing. A Janus
proxy implementation was scoped and about to start.

**What broke the false trail:** David observed that Alarm.com's **phone app** streamed the camera
while their **website** timed out. Two first-party clients disagreeing is a fact about the network
path — it cannot be explained by any server-side, protocol, or entitlement theory. That reframed
everything, and the camera's WiFi signal turned out to be poor.

**Actual root cause: poor WiFi signal at the camera.** Per Alarm.com's
[knowledge base](https://answers.alarm.com/Customer/Website_and_App/Video/Live_Video/View_live_video),
a Proxy connection *"means that attempts to establish a Direct or Relayed connection have
failed"*, times out after 3 minutes, and carries no audio — which is why a demoted camera reports
`proxyStreamTimeoutTime: 180` and `supportsAudio: false`. Proxy is the **failure fallback**. A weak
link made Direct connections fail; Alarm.com demoted the camera; our bridge only speaks Direct.

**Resolution:** power-cycling the camera cleared the demotion.
`endToEndWebrtcConnectionInfo` returned with data (plus `webrtcStreamQualityMessage` entries,
which only appear on a healthy source), and video was verified end to end — 84–127 KB JPEGs with
three distinct md5s across 30 s, and a real `rtsp+tcp` publisher in go2rtc with bytes climbing.

**No code was changed.** The lesson is recorded as a diagnostic order in the baton: check
Alarm.com's own clients *first*, and treat a disagreement between them as a network-path signal.

### Measured performance findings

Two hypotheses were tested and **refuted**:

1. *"Homebridge is re-encoding."* It is not — `vcodec: "copy"`. No transcode, no wasted NAS CPU.
2. *"The 10-second ffmpeg `analyzeduration` delays startup."* It does not. `analyzeduration` is a
   ceiling, not a fixed wait. Cold start measured **1.52 s** from RTP port allocation to first RTP
   packet: signaling session 0.26 s, SDP offer 0.51 s, ffmpeg spawned 0.55 s, peer connection
   connected 1.51 s, first packet 1.52 s. There is nothing to reclaim here.

One finding that **was** real, and was not on the original list:

3. **A ~1.2 s media gap every 600 s.** At each token refresh the peer connection closes and RTP
   resumes ~1.2 s later — consistently, every cycle. The good news is that `Starting ffmpeg`
   appears exactly **once** in 30 minutes, so the seamless-handoff design works: ffmpeg and the UDP
   socket survive refreshes and the RTSP publisher never drops. But it is seamless at the
   *transport* layer only. `reconnect()` closes the old PeerConnection **before** building the new
   one — break-before-make — so ffmpeg receives nothing during the overlap. Invisible for live
   viewing; **not** necessarily invisible to HKSV, which cares about media continuity.
   Fix: make-before-break — establish the new connection, wait for RTP on it, then tear down the
   old one.

Untested and deliberately deferred: `-reorder_queue_size 0` disables RTP reordering, which is
right on a clean LAN and possibly wrong over a weak wireless link. Worth an A/B **after** the
signal problem is fixed, not before.

### Native HKSV via go2rtc — SPIKED AND MEASURED, and the initial assessment was wrong

**Correcting the section below.** It argued against native HKSV partly on "we already do not
re-encode, because `vcodec: \"copy\"`". That reasoning was **wrong**: `vcodec` governs the
**live-view** path, not HKSV *recording*, which is a separate path in `camera-ffmpeg` with much
harder constraints (fragmented MP4, GOP alignment, strict profile/level) — exactly the constraints
that normally force a transcode. Generalising from one config key to a feature it does not govern
nearly talked us out of a real improvement.

So we spiked it. Findings, measured on Kaikoura against the live camera:

| | idle | live view | **HKSV recording** |
|---|---|---|---|
| go2rtc CPU | 0.4% | 0.4% | **0.7%** |
| RSS | 23 MB | 22 MB | **21–22 MB** |
| ffmpeg processes | 0 | 0 | **0** |

**Native HKSV recording does not re-encode.** The debug log shows `[hksv] flush fragment
fragSize≈67000` once per second with sequential `seq` numbers (≈536 kbps, consistent with 1080p10
H.264 straight through), and a third consumer appears with `format_name: "hksv"` alongside the
live `homekit` one, both fed from a single `rtsp` producer. It muxes rather than encodes, as
`pkg/hksv`'s README claims — now verified on our hardware.

Also learned: HomeKit negotiated 1280x720@30 while the source is 1920x1080@10, and **accepted the
mismatch** without transcoding. The same tolerance explains why the Homebridge path works despite
`maxWidth`/`maxHeight` being inert under `vcodec: "copy"`.

**How the spike was run** (repeat this way — it was cheap and completely isolated): go2rtc is a
single static Go binary and cross-compiles trivially, so there was **no Docker image, no sudo, and
no change to the deployment**. Built `skrashevich/go2rtc@hksv` with
`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`, copied the 19 MB binary to the NAS, ran it as `dpeak` on
spare ports (1985/8555) pulling the RTSP stream the production go2rtc already publishes. Running
on the host rather than in a container also made HomeKit's mDNS advertisement work for free —
the awkward part of running HAP in Docker. Teardown was `kill` + `rm -rf`. `pkg/hksv` and
`internal/homekit` unit tests pass.

⚠️ Gotchas hit while spiking, worth not rediscovering:
- `pkg/hksv` hardcodes the pairing pin to **`27041991`** when unset — publicly documented, so
  always set a random `pin:`.
- `pkg/hksv/hksv.go:293` logs `ERR ... error=EOF` on an aborted pair-setup attempt even when
  pairing then succeeds. Log noise, not a fault.
- `pkill -f "go2rtc -config ..."` **matches its own ssh command line** and kills the session
  before doing anything. Resolve the PID with `ps` and kill that instead.
- `scp` resolves `kaikoura` differently than `ssh` does (the `Match exec` block in
  `~/.ssh/config`); pipe over `ssh 'cat > file'` instead.

**What is still unmeasured:** what HKSV *recording* costs on the Homebridge path. It was never
enabled there (`videoConfig.recording` defaults to `false`, and that camera has no `motion` key),
and measuring it would have required a production config edit plus a Homebridge restart that
interrupts unrelated accessories. Deliberately skipped: the direction of the result does not change
the decision, only its margin.

🔴 **The spike was easy partly BECAUSE it was not containerised — production adoption does not get
that.** HomeKit pairing requires mDNS advertisement on the real LAN. A host process does that
natively (it coexisted with Synology's Bonjour with no fiddling). **Docker's bridge network does
not forward multicast**, so a containerised HKSV go2rtc needs `network_mode: host`, a `macvlan`
network, or an mDNS reflector — and `network_mode: host` conflicts directly with the network
isolation `SECURITY_AUDIT.md` documents (no port mapping, no `ADC_BRIDGE_BIND_ADDRESS`
confinement). Note the scope precisely: host networking costs **only** the network-namespace
control. Read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, non-root, and digest pinning all
survive it. So this is one specific trade, not abandoning the audit.
⚠️ Compounding it: go2rtc is currently **fused into the bridge image** — the Dockerfile uses
`alexxit/go2rtc` as its runtime base and `entrypoint.sh` starts go2rtc then Node. So a naive
adoption would put the **ADC-credential-holding bridge** on host networking too. Splitting go2rtc
into its own container is what scopes the compromise to the HomeKit-facing component alone.

**Revised position:** the benefit is now **established rather than speculative**, but the *costs*
are unchanged — [go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is still unmerged and
unreleased, so adopting it in production means self-building from a branch and giving up the
Dockerfile's by-digest pin. Track it; adopt when it merges and ships. The reasoning in the
superseded section below is retained only to show what the wrong argument looked like.

### Native HKSV via go2rtc — the original (superseded) assessment

[go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130) is **still open** (not merged, not
draft, 8,399 additions across 35 files, last updated 2026-07-27), and go2rtc's latest release is
v1.9.14 from January. There is no release path; adopting it means self-building from an unmerged
branch.

Upstream `Omar-L#11` argues two benefits, and both fail **for this deployment**: the re-encoding it
eliminates is already not happening (`vcodec: "copy"`), and the Homebridge stack it removes is
staying regardless, because this Homebridge also hosts non-camera accessories. Meanwhile the cost
is concrete: the Dockerfile pins go2rtc **by digest**, and `SECURITY_AUDIT.md` names that as a
deliberate supply-chain control. Swapping in a self-built binary from an unmerged PR — running as a
HomeKit accessory holding pairing keys — trades that guarantee away.

HKSV already works through the current stack, so this is an optimization of a working path, not an
enabler. **Decision: track it; revisit after it merges and ships in an official release.**

### Upstream contribution — Omar asked, so we shipped what we had

Omar (upstream maintainer) reached out asking how the fork was going, *"especially if you can make
it run more stable."* The fork was **12 commits ahead, 0 behind** — a clean superset — and two of
those commits were exactly that.

Opened `Omar-L#23` (track subscription) and `Omar-L#24` (stale ffmpeg exit, stacked on #23).
They had to stack: cherry-picking the ffmpeg fix alone onto `upstream/main` conflicts, because
both edit the ffmpeg lifecycle and the track fix landed first.

**Both bugs are the same shape**, which is worth carrying forward as a review lens: *a reference
held without asking which instance it points to.* One is a placeholder track winning a one-shot
guard the real track needed; the other is a dead process's callback mutating state belonging to
its replacement. Object-lifecycle identity confusion, twice.

Also filed `#25` (the ~1.2s media gap, with measurements) and commented on `#2` and `#9` rather
than opening duplicates — `#2`'s "older camera models" framing needed the correction that any
camera can be demoted into proxy, and `#9` needed the failure-rate data plus the null-vs-throw
trap.

Deliberately **not** upstreamed yet: the hardening commit (`395d888`, 826/-420 across 30 files)
needs splitting into reviewable pieces first. Everything else portable is small and can follow.

### Splitting `395d888` into reviewable upstream PRs

The hardening commit was 826/-420 across 30 files — unreviewable as one change, and the reason its
`URLSearchParams` regression shipped unnoticed in the first place. Split into four PRs off
`upstream/main`, each verified independently:

| PR | slice |
|---|---|
| [#28](https://github.com/Omar-L/adc-video-bridge/pull/28) | network hardening — WSS enforcement, handshake/payload bounds, HTTP timeouts, payload redaction. **Carries `6a4f5a4`** |
| [#29](https://github.com/Omar-L/adc-video-bridge/pull/29) | log redaction, configurable level, clean shutdown, bounded webhook |
| [#30](https://github.com/Omar-L/adc-video-bridge/pull/30) | config validation at load time + `ADC_*_FILE` secrets |
| [#31](https://github.com/Omar-L/adc-video-bridge/pull/31) | container hardening — non-root, read-only, `cap_drop`, digest pins |

Slice E (the `audit:prod` policy) stays **held** until their Dependabot PRs merge — see the earlier
entry on `Omar-L#27`.

🔴 **The verification method was wrong for the first two slices, and it produced a false failure and
a false explanation.** Checking "does this slice build standalone" ran `tsc` against **our**
`node_modules` — werift **0.24.2** — while the branches are based on upstream, which pins
**^0.19.7**. Pristine `upstream/main` does not compile against 0.24 either, so the failures had
nothing to do with the slices.

Two consequences. A phantom error on the logging slice sent me looking for a dependency that was not
there. And I wrote into `#28`'s commit message that a `camera-stream.ts` null guard was required
"once the logging is narrowed" — it is not; **werift 0.24 made the ICE candidate callback nullable**.
That had to be amended.

**Fix: verify against a clean `git clone` of upstream with `npm ci` from THEIR lockfile.** Every slice
was then re-checked there. Worth keeping that clone around for future upstream work.

That mistake produced the single most useful line in the whole series, though: since upstream's own
Dependabot **#17** proposes the werift bump, **merging #17 without `#28`'s guard breaks their build.**
An incidental line became the reason to take the PR.

⚠️ Also learned: **diff size does not measure independence.** `fd3b3dd` and `3ac3b0a` are ~19 lines
between them and read as trivially portable. They are not — one adds a `secrets/` directory for
`ADC_*_FILE` support upstream lacks, the other aligns container UID/GID with a non-root user and
mode-600 configs upstream lacks. Both are interface changes to a feature living in `395d888`, and
both were folded into `#31` where they belong.

### The event WebSocket 401s were self-inflicted, and nearly exported

Fixed the ~60/hour `401` failures on the ADC event stream. **Root cause: we double-encoded our own
auth token.**

Alarm.com's WebSocket token is not an opaque blob — it is ~600 characters of *already*
URL-encoded querystring (`%XX` escapes, `&` separators, `=` assignments). `connect()` passed it
through `URLSearchParams.set()`, which encoded it a second time: every `%` became `%25`, every `&`
became `%26`, producing a URL 45 characters longer than it should be. Alarm.com could not decode
it and rejected the handshake.

Nothing was wrong with the credentials, the session, or the token — which is why the logs showed
`WebSocket error` and never `Failed to connect`. `auth.get()` returned a valid token every time.

**The differential test that found it:** `src/ws-probe.ts` builds the URL by raw string
concatenation and `alarm-event-listener.ts` used `searchParams`. Running the probe against the live
endpoint **connected and received events** at the same moment the listener was 401ing. Same
account, same token endpoint, same minute — the only difference was the encoding.

Fixed by assigning `wsUrl.search` directly, which leaves `%`, `&` and `=` untouched while keeping
`new URL()` for the `wss:` check and preserving the normalised form. Verified end to end against
the live endpoint: connected, received events, **0 errors**.

⚠️ **Why 116 passing tests missed it:** the fixture token was `'ws-token-123'` — clean, readable,
and **URL-safe**, so re-encoding it is a no-op. The test asserted precisely the behaviour that
breaks in production. A tidy fixture did not merely fail to catch the bug, it *certified* the
broken code. **For anything encoded, escaped, quoted or serialised, the fixture must be hostile.**

🔴 **The uncomfortable part: the bug was ours, and it was queued to be exported.** `git log -S`
traced it to `395d888 "Harden bridge and Synology deployment"`, which added the `wss:` check and
the bounded handshake — and switched to `new URL()` + `searchParams.set()` in the same breath.
`upstream/main` still uses `` `${endpoint}?auth=${token}` `` and is **not affected**.

`395d888` was on the "portable, un-upstreamed" list. Upstreaming it as-is would have handed the
maintainer a regression that kills motion events for every user, inside a commit titled "harden".
The change *reads* as a security improvement, which is exactly why it was reviewed, merged and
deployed without anyone noticing. **Precondition recorded in the baton: never offer `395d888`
without `6a4f5a4` folded in.**

### Deferred to a future session

The **ADC API circuit breaker** (upstream `Omar-L#9`) was scoped but deliberately not started.
Decisions already made, so the next session does not re-litigate them:

- **Scope: all three retry loops**, not just token calls. Measured during the outage: the event
  WebSocket produced ~60 failures/hour (backoff caps at 60 s) versus ~6/hour from the token poller
  (caps at 600 s). Guarding only `token-manager.ts`, as upstream proposes, would leave 60 of 66
  hourly failures untouched. Backoff bounds the *rate* between attempts; nothing bounds the
  *duration* of attempting, and a saturated ladder is still an infinite loop.
- **Open behavior: pause, log once loudly, then probe on a long escalating cooldown**
  (5 m → 15 m → 30 m → cap 1 h) **forever**; one success closes it. Self-healing matters — a
  breaker that stays open until restarted would have kept the cameras dark after the power-cycle
  that fixed them.
- 🔑 **The failure predicate must be "did not produce a usable result," not "threw."** A breaker
  counting exceptions **would not have tripped once** during this outage: `fetchVideoSource`
  *returns `null`* and `fetchVideoTokenSilent` logs a warning without throwing or emitting `error`.
  To every error path in this codebase, a seven-hour failure looked like a series of successful
  calls returning nothing. Getting this wrong ships a breaker that passes review and sleeps through
  the exact outage it was built for.
