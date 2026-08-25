# Upstream contributions — Omar-L/adc-video-bridge

Everything about **sending work upstream**: what is open, what is deliberately held, and the rules
that keep a contribution from embarrassing us in someone else's repository.

Split out of `docs/AGENT_HANDOFF.md` on 2026-08-04. It lives here because it changes on the
**maintainer's** schedule, not ours — re-reading it every session to find that nothing moved was
most of what made the baton long. The baton keeps a one-line pointer and the current count.

> 🔄 **Refresh before trusting the table.** Whether a PR is still open is a fact GitHub owns, not
> this file:
>
> ```bash
> gh pr list --repo Omar-L/adc-video-bridge --author @me --state all --limit 20
> ```
>
> 🔴 **And do NOT report BRANCH state from this clone either.** The fork's `upstream-fix/*` branches
> get rebased without this checkout hearing about it. Measured 2026-08-11: `stale-ffmpeg-exit` was
> `1bec1ae` locally and `d537457c` on the fork, `webrtc-track-subscription` `82e595a` locally and
> `d0eb67d1` on the fork, and neither rebase was done from here. Reading local refs would have
> reported #24 as needing a rebase it had already had.
>
> ```bash
> git ls-remote git@github.com:Peak-Innovation-Studios/adc-video-bridge.git 'refs/heads/upstream-fix/*'
> ```

---

## Pull requests — 2 merged, 7 open (as of 2026-08-11)

🔑 **Live state 2026-08-11, from the API not this file.** All seven open PRs are `MERGEABLE` and
every one reports `mergeStateStatus: BLOCKED`, which resolves to `reviewDecision: REVIEW_REQUIRED`.
That is **branch protection waiting on the maintainer, not a defect in any branch**. Nothing is
blocked on us. ⚠️ Do not read `BLOCKED` as "something is wrong with our branch" — it cost a
diagnosis once.
🔑 **All three of our issues (#25, #27, #35) have zero comments.** No maintainer response on any.

Omar-L asked for help making the fork more stable. All of these branch off `upstream/main` and
contain **no internal docs**. ⚠️ Status goes stale — re-check with
`gh pr list --repo Omar-L/adc-video-bridge --state all`.

| PR | branch | status | note |
|---|---|---|---|
| [#23](https://github.com/Omar-L/adc-video-bridge/pull/23) | `upstream-fix/webrtc-track-subscription` | open | placeholder track wins a one-shot guard |
| [#24](https://github.com/Omar-L/adc-video-bridge/pull/24) | `upstream-fix/stale-ffmpeg-exit` | open | **stacked on #23** — conflicts standalone |
| [#26](https://github.com/Omar-L/adc-video-bridge/pull/26) | `upstream-fix/pin-actions` | ✅ **MERGED** | CI hardening |
| [#28](https://github.com/Omar-L/adc-video-bridge/pull/28) | `upstream-fix/network-hardening` | open | 🔴 **carries `6a4f5a4`** — must not ship without it |
| [#29](https://github.com/Omar-L/adc-video-bridge/pull/29) | `upstream-fix/log-redaction` | ✅ **MERGED** | redaction, log level, shutdown |
| [#30](https://github.com/Omar-L/adc-video-bridge/pull/30) | `upstream-fix/config-validation` | open | validation + `ADC_*_FILE` |
| [#31](https://github.com/Omar-L/adc-video-bridge/pull/31) | `upstream-fix/container-hardening` | open | non-root, read-only, digest pins |
| [#32](https://github.com/Omar-L/adc-video-bridge/pull/32) | `upstream-fix/circuit-breaker` | open | closes `#9`; 136 tests on THEIR tree. ⚠️ **REBASED 2026-08-08** — see below |
| [#34](https://github.com/Omar-L/adc-video-bridge/pull/34) | `upstream-fix/media-watchdog` | open | fail an attempt that negotiates but delivers no media; 108→113 on THEIR tree |

⚠️ **#28, #23/#24 and #34 all touch `camera-stream.ts`**, and **#32 touches
`alarm-event-listener.ts` and `camera-manager.ts`** — whichever merges last needs a trivial rebase.

🔑 **#34 is worth reading for what it says about THEIR test suite, not just the fix.** Every
existing `camera-stream` test mocks `tryConnect()`, so nothing exercised the changed path — the
port's 108 tests passed *immediately*, which read like good news and was actually the warning.
⚠️ **Mutation testing then caught a gap in the new tests themselves:** removing the settle call
broke nothing, because the positive control invoked the internal resolver directly and so
substituted the exact wiring under test. Extracting a single `markStreaming()` transition fixed it.
**Assume any test you add upstream is untested until a mutation kills it.**

### ⚠️ The predicted rebase tax came due — #32, 2026-08-08

**#32 went `CONFLICTING` and could not be merged**, exactly as the "whichever merges last needs a
trivial rebase" note below predicted. Cause: **#29 merged** and touched `src/index.ts`, which #32
also touches. The conflict was a single hunk — #29 added a `statusTimer` handle so the status
interval can be cleared on shutdown; #32 changed the same `setInterval` call to add an
`eventCircuit` field. **Resolution keeps both.**

🔑 **How it was verified before force-pushing**, and the pattern to reuse:
- `git merge-tree --write-tree --name-only origin/main <branch>` names the conflicted files and
  touches nothing. ⚠️ The **3-argument** `merge-tree` form is the old one and does NOT report
  conflicts usefully — it prints a merge diff and looks clean. Use `--write-tree`.
- `git range-diff` after the rebase showed **one** changed line, the resolution itself. That is the
  proof the rebase dropped nothing.
- `npm ci` + build + suite against THEIR lockfile: 136 tests.
- Pushed with `--force-with-lease=<branch>:<old-sha>`, so it aborts if the remote moved.
- Left a comment on the PR saying why the branch moved — a force-push under an open PR is confusing
  otherwise.

⚠️ **Expect this again.** #23, #24, #28 and #34 all touch `camera-stream.ts`; the moment one merges,
the others need the same treatment.

### 🔴 Do NOT "sync fork" as PRs merge — wait until all six land, then reconcile once

Measured 2026-08-06 with `git merge-tree main upstream/main` (a dry run that touches nothing):
merging `upstream/main` **conflicts** in `.github/workflows/ci.yml`, `src/index.ts` and
`src/utils/logger.ts`. GitHub's "Sync fork" button cannot do it.

🔑 **The conflicts exist BECAUSE the PRs were split correctly.** Each branches off `upstream/main`
rather than being carved out of our `main`, which is what makes them reviewable — and what leaves
the same change existing twice as two unrelated commits descending from one ancestor. Git cannot
know they are the same intent. This is the standing tax of a fork that upstreams its own work; it
will recur on **every** merged PR, and more are coming that touch the same files.

**There is nothing to gain content-wise.** Tree-to-tree, our `main` is effectively a superset:
`logger.ts` is `+15/-0` (we contain their version entirely), `index.ts` `+82/-9`, `ci.yml` `+10/-1`.
Syncing buys only a reconnected history for future merges.

⚠️ Before any reconciliation, inspect the **9 lines in `index.ts` and 1 in `ci.yml`** that upstream
has and we do not — they are the only places their tree carries something ours lacks, and a
`-s ours` merge would silently discard them. Not yet checked.

## Open issues and other contributions

- 🔑 **go2rtc [#2130](https://github.com/AlexxIT/go2rtc/pull/2130) — the HAP auth loop is CLOSED.**
  Reported 2026-08-08, implemented independently by Mo3he in `6f76ea9a` (credited to the report),
  adopted here 2026-08-25, and `patches/go2rtc-hap-auth-exempt.patch` is **deleted**. That is the
  whole arc `INVARIANTS.md` asked for.
  ✅ **Posted a verification comment 2026-08-25** with the one fact nobody else in the thread had:
  `pkg/hap/tlv8` and `pkg/hap/camera` **fail on the current PR head** and pass on Mo3he's branch,
  measured by diffing failing-package lists across both commits. Zero regressions the other way.
  ⚠️ **Deliberately understated the production claim.** Only one of three cameras was online that
  day, so "running across three cameras" would have been false. On a thread trading validation
  reports, an overclaim that needs walking back later costs more than a narrow honest one.
  ⚠️ Did **not** `@`-mention the maintainer. Pinging them to advocate for a third party's fork reads
  as pressure; the merge-strategy question stands on its own.
  ➡️ **Watch for an answer to:** whether those fixes get folded into #2130 or land as separate PRs.
  Either way, when #2130 ships officially the whole `Dockerfile.go2rtc` build stage goes away and we
  return to the digest-pinned `alexxit/go2rtc` image.

- 🔑 [#35](https://github.com/Omar-L/adc-video-bridge/issues/35) — **filed 2026-08-08: cameras
  publish a local RTSP endpoint on the LAN.** The finding that overturns this project's founding
  premise, offered upstream rather than kept in the fork. Explains what it makes moot (#7, #10),
  what it solves differently (#2), and what it improves (#11), plus the honest catch: it still needs
  one proxied capture of the app for the device fields.
  ➡️ **Ends with a question worth watching for an answer to:** whether `Haiku` is per-install or a
  client constant. Anyone else's capture settles it, and if it is a constant the proxy step
  disappears for everyone.
  ⚠️ Deliberately framed as "do you want this here at all" rather than a PR — it is an architectural
  change, not a patch, and Omar has not asked for it.

- [#25](https://github.com/Omar-L/adc-video-bridge/issues/25) — measured ~1.2s media gap at token
  refresh. ✅ **Fixed on our `main`** by the make-before-break merge (2026-08-04); not yet offered
  upstream as a PR.
- [#27](https://github.com/Omar-L/adc-video-bridge/issues/27) — 7 production advisories.
- Comments on `#2`, `#9`, `#11`.
- A validation report on [AlexxIT/go2rtc#2130](https://github.com/AlexxIT/go2rtc/pull/2130).

## 🔒 Held, not forgotten

- **`upstream-fix/production-audit-policy`** — built and committed locally but **deliberately
  unpushed**. The policy fails on upstream's tree today (see #27). Send it once their Dependabot
  PRs merge.
- ✅ `395d888` is fully split and upstreamed via #28–#31. Only `baa7ab2` (Synology guide) remains
  portable and unsent.

---

## Rules for anything sent upstream

### 🔴 Verify slices against UPSTREAM's lockfile, not ours

A clean clone with `npm ci` from **their** `package-lock.json` is the only valid test bed. Our fork
pins `werift ^0.24.2`, upstream `^0.19.7`, and **pristine `upstream/main` does not compile against
0.24** — building slices in our tree once produced a phantom failure and a wrong claim that had to
be amended out of a PR message.

⚠️ **Make a fresh clone each time; do not go looking for the last one.** Earlier sessions kept it in
the agent session scratchpad, which is session-scoped and does not survive:

```bash
git clone git@github.com:Omar-L/adc-video-bridge.git /tmp/upstream-check && cd /tmp/upstream-check && npm ci
```

✅ **This rule has caught a real defect, not just a phantom one.** #32's fixtures used
`iceServers: []`, which passes here only because our parser has an `Array.isArray` branch; upstream
`JSON.parse()`s the field directly, so the array threw and hung five tests until vitest's 5s
timeout. Fixed on both branches (`e971299`).

🔑 **The trap is broader than the werift pin: any fixture exercising code our hardening made more
tolerant will pass here and fail there.** Our parsers accept shapes theirs rejects. Assume every
fixture is suspect until it has run on their tree.

### ⚠️ Never let internal docs into an upstream PR

`docs/AGENT_HANDOFF.md`, `Journal.md`, `CLAUDE.md`, `AGENTS.md`, and anything under
`docs/superpowers/` stay in this fork. `8f88c26` and `baa7ab2` touch the baton and need stripping
on cherry-pick.

### No AI attribution

No `Co-Authored-By` trailer, no "generated with" footer, in commits, PR bodies, issue bodies, or
review comments — here or in anyone else's repository.
