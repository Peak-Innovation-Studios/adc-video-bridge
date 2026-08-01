# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff. Narrative history belongs elsewhere.

---

## Current handoff

- **Last agent:** Codex
- **Updated:** 2026-08-01 (fork, audit, hardening, CI, and Kaikoura staging complete)
- **Branch / HEAD:** `agent/harden-synology-deployment` at `3319d75`; fork PR [Peak-Innovation-Studios/adc-video-bridge#1](https://github.com/Peak-Innovation-Studios/adc-video-bridge/pull/1) is open as a draft. A push does not deploy; Kaikoura runs a separate Container Manager checkout.
- **Working tree:** Clean before this baton update. No intentional uncommitted product work is expected.
- **Validation:** clean install, TypeScript build, 9 test files / 113 tests, production audit policy, shell syntax, YAML parsing, Compose rendering, diff check, image build, and a non-root runtime-tool smoke check passed in GitHub Actions run `30722523445`.
- **Kaikoura:** `/volume1/docker/adc-video-bridge` contains the current branch plus protected `.env`, `config/config.yaml`, and `config/go2rtc.yaml`. Compose rendering and required-file checks pass. The staged pilot is camera `Front`, stream name `front`; motion and HKSV remain disabled.
- **Whose turn:** David — start the staged Container Manager project with Synology administrator privileges. Codex can then resume output validation and Homebridge configuration.

### What's left (priority order)

1. Human/admin: on Kaikoura, run `cd /volume1/docker/adc-video-bridge` and `sudo /var/packages/ContainerManager/target/usr/bin/docker-compose up --build -d`. The current SSH user cannot access the Docker socket or noninteractive sudo.
2. Verify authenticated snapshot and RTSP output before changing Homebridge.
3. Install `@homebridge-plugins/homebridge-camera-ffmpeg`, add the Front Camera pilot, restart Homebridge, and verify Apple Home live view.
4. Enable motion and HKSV only after stable live-view validation.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or captured frames.
- The documented npm audit exception is limited to GHSA-2p57-rm9w-gvfp and is guarded by a check that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the maintained scoped camera package, not the stale unscoped npm package.
- Use the normal Homebridge UI login to install the plugin. Do not mint or reuse internal UI tokens to bypass authentication.
- Ports 8554 and 1984 are authenticated but unencrypted on the LAN; bind only to the intended host address and do not forward them.

### Open decisions

- Whether to enable Alarm.com motion webhooks and HKSV after the initial live-view pilot is stable.
