# Upstream contributions — Omar-L/adc-video-bridge

Everything about **sending work upstream**: what is open, what is deliberately held, and the rules
that keep a contribution from embarrassing us in someone else's repository.

Split out of `docs/AGENT_HANDOFF.md` on 2026-08-04. It lives here because it changes on the
**maintainer's** schedule, not ours — re-reading it every session to find that nothing moved was
most of what made the baton long. The baton keeps a one-line pointer and the current count.

> 🔄 **Refresh before trusting the table.** Whether a PR is still open is a fact GitHub owns, not
> this file:
> ```bash
> gh pr list --repo Omar-L/adc-video-bridge --author @me --state all --limit 20
> ```

---

## Open pull requests

Omar-L asked for help making the fork more stable. All of these branch off `upstream/main` and
contain **no internal docs**.

| PR | branch | note |
|---|---|---|
| [#23](https://github.com/Omar-L/adc-video-bridge/pull/23) | `upstream-fix/webrtc-track-subscription` | placeholder track wins a one-shot guard |
| [#24](https://github.com/Omar-L/adc-video-bridge/pull/24) | `upstream-fix/stale-ffmpeg-exit` | **stacked on #23** — conflicts standalone |
| [#26](https://github.com/Omar-L/adc-video-bridge/pull/26) | `upstream-fix/pin-actions` | CI hardening |
| [#28](https://github.com/Omar-L/adc-video-bridge/pull/28) | `upstream-fix/network-hardening` | 🔴 **carries `6a4f5a4`** — must not ship without it |
| [#29](https://github.com/Omar-L/adc-video-bridge/pull/29) | `upstream-fix/log-redaction` | redaction, log level, shutdown |
| [#30](https://github.com/Omar-L/adc-video-bridge/pull/30) | `upstream-fix/config-validation` | validation + `ADC_*_FILE` |
| [#31](https://github.com/Omar-L/adc-video-bridge/pull/31) | `upstream-fix/container-hardening` | non-root, read-only, digest pins |
| [#32](https://github.com/Omar-L/adc-video-bridge/pull/32) | `upstream-fix/circuit-breaker` | closes `#9`; verified 108→136 tests on THEIR tree |

⚠️ **#28 and #23/#24 all touch `camera-stream.ts`**, and **#32 touches `alarm-event-listener.ts` and
`camera-manager.ts`** — whichever merges last needs a trivial rebase.

## Open issues and other contributions

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
