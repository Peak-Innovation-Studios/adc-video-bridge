# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff. Narrative history belongs elsewhere.

---

## Current handoff

- **Last agent:** Codex
- **Updated:** 2026-08-01 (forked the project and completed the first security/deployment hardening pass)
- **Branch / HEAD:** Run `git fetch && git status --short && git log --oneline -1 && git rev-list --count origin/agent/harden-synology-deployment..agent/harden-synology-deployment`. A push does not deploy; Kaikoura runs a separate Container Manager checkout.
- **Working tree:** Run `git status --short`. No intentional uncommitted work is expected after the hardening commit.
- **Validation:** clean install, TypeScript build, 9 test files / 113 tests, production audit policy, shell syntax, YAML parsing, Compose rendering, and diff check passed. Local image build is unavailable because Docker Desktop is stopped; CI must verify the image.
- **Whose turn:** Codex — commit, push, verify CI, then prepare and start the Kaikoura pilot when administrative Container Manager access is available.

### What's left (priority order)

1. Commit and push the hardening branch; verify the CI image build and runtime-tool smoke check.
2. Place the one-camera ADC-V723 configuration and secret files on Kaikoura without logging their values.
3. Human/admin: build and start the Container Manager project; the current SSH user cannot access the Docker socket or noninteractive sudo.
4. Verify authenticated snapshot and RTSP output before changing Homebridge.
5. Install `@homebridge-plugins/homebridge-camera-ffmpeg`, add the Front Camera pilot, restart Homebridge, and verify Apple Home live view.
6. Enable motion and HKSV only after stable live-view validation.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or captured frames.
- The documented npm audit exception is limited to GHSA-2p57-rm9w-gvfp and is guarded by a check that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the maintained scoped camera package, not the stale unscoped npm package.
- Ports 8554 and 1984 are authenticated but unencrypted on the LAN; bind only to the intended host address and do not forward them.

### Open decisions

- Whether to enable Alarm.com motion webhooks and HKSV after the initial live-view pilot is stable.
