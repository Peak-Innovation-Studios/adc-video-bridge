# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff. Narrative history belongs elsewhere.

---

## Current handoff

- **Last agent:** Codex
- **Updated:** 2026-08-02 (live bridge, Homebridge plugin, and child-bridge pilot validated)
- **Branch / HEAD:** `agent/harden-synology-deployment` at `1392445`; fork PR [Peak-Innovation-Studios/adc-video-bridge#1](https://github.com/Peak-Innovation-Studios/adc-video-bridge/pull/1) remains a draft pending final Apple Home confirmation.
- **Working tree:** Clean before this baton update. No intentional uncommitted product work is expected.
- **Validation:** TypeScript build, 9 test files / 114 tests, production audit policy, image build, and non-root runtime smoke passed in GitHub Actions run `30724375024`. Live Kaikoura checks returned an authenticated 1280x720 JPEG, RTSP `200 OK`, and H.264 Main level 3.1 at 10 fps.
- **Kaikoura:** `/volume1/docker/adc-video-bridge` runs the current branch with protected local configuration. Camera FFmpeg 4.1.0 runs as its own Homebridge child bridge; the Front Camera external accessory and child-bridge listeners are active. Homebridge logs show multiple video sessions starting and stopping cleanly. Motion, doorbell, audio, and HKSV remain disabled.
- **Whose turn:** David — confirm live video in Apple Home. Codex can then finalize the PR/handoff and decide whether to start a separate motion/HKSV follow-up.

### What's left (priority order)

1. Confirm the paired Front Camera displays live video in Apple Home.
2. Keep the live-view-only pilot stable before enabling motion notifications or HKSV.
3. Mark the fork PR ready and prepare the upstream PR after live confirmation.

### Do not touch / gotchas

- Never commit `.env`, `secrets/`, real camera configuration, logs, tokens, camera IDs/names, or captured frames.
- The documented npm audit exception is limited to GHSA-2p57-rm9w-gvfp and is guarded by a check that werift does not call `ip.isPublic()`.
- Homebridge 2 uses the maintained scoped camera package, not the stale unscoped npm package.
- Use the normal Homebridge UI login to install the plugin. Do not mint or reuse internal UI tokens to bypass authentication.
- Ports 8554 and 1984 are authenticated but unencrypted on the LAN; bind only to the intended host address and do not forward them.
- Homebridge `config.json` is mode 600 and a pre-camera mode-600 backup exists at `config.json.bak-adc-camera-20260801-191305`.
- If Synology reports package start failure while the Homebridge user manager has no D-Bus socket, verify Homebridge itself in a bounded foreground run, then recreate only that stale session with `sudo loginctl terminate-user homebridge` before starting the package normally.

### Open decisions

- Whether to enable Alarm.com motion webhooks and HKSV after the initial live-view pilot is stable.
