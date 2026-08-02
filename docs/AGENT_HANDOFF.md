# Agent Handoff — Live Baton

This is the single live answer to **"what is the current state, and whose turn is it?"** Claude, Codex, and David rewrite this block at every handoff. Narrative history belongs elsewhere.

---

## Current handoff

- **Last agent:** Codex
- **Updated:** 2026-08-02 (deployment documentation published for merge)
- **Branch / HEAD:** `agent/document-synology-updates`, based on merged `main` at `5bab6d7`. Internal PR [Peak-Innovation-Studios/adc-video-bridge#2](https://github.com/Peak-Innovation-Studios/adc-video-bridge/pull/2) carries the documentation update into `main`.
- **Working tree:** Expected clean after this handoff. The documentation branch is pushed; no intentional uncommitted work remains.
- **Diagnosis:** Kaikoura logs showed each exiting FFmpeg reporting about 37 seconds elapsed even though the currently referenced process had started about 20 seconds earlier. A stale child `exit` callback cleared the replacement reference and triggered `onUnexpectedExit`, tearing down a healthy WebRTC session. go2rtc consequently accumulated two publishers and 248 stuck Homebridge consumers.
- **Fix:** Detach FFmpeg ownership before `SIGTERM` and ignore `exit` events unless the exiting child is still the owned child. Two regression tests cover synchronous intentional-stop exit and late exit after replacement.
- **Validation:** The merged code passed TypeScript build, 9 test files / 116 tests, focused 26-test camera suite, production audit policy, and CI. Documentation passes `git diff --check`; live Docker validation remains pending.
- **Kaikoura:** `/volume1/docker/adc-video-bridge` is a single-branch pilot checkout at `1392445`, with a fetch rule limited to `agent/harden-synology-deployment`. The new Synology guide records the safe migration to `main` and required image rebuild. Motion, doorbell, audio, and HKSV remain disabled. Alarm event WebSocket 401s are separate from the live-video publisher race.
- **Whose turn:** David — migrate and rebuild Kaikoura from merged `main`, then validate the live feed.

### What's left (priority order)

1. Migrate/rebuild Kaikoura from `main` and verify `front` remains on one RTSP publisher.
2. Confirm snapshots and live video in Apple Home.
3. Keep the pilot stable before enabling motion/HKSV.

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
