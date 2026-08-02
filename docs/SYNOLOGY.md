# Synology Container Manager Deployment

This deployment keeps runtime configuration under `/volume1/docker/adc-video-bridge` and uses the Compose project included in the repository.

## Prepare the project

Clone the maintained fork to the Synology, then create local configuration:

```bash
git clone https://github.com/Peak-Innovation-Studios/adc-video-bridge.git \
  /volume1/docker/adc-video-bridge
cd /volume1/docker/adc-video-bridge
mkdir -p secrets
chmod 700 config secrets
cp .env.example .env
cp config/config.example.yaml config/config.yaml
cp config/go2rtc.example.yaml config/go2rtc.yaml
chmod 600 .env config/config.yaml config/go2rtc.yaml
```

In `.env`:

- Set the Alarm.com login, or create mode-600 files under `secrets/` and set the corresponding paths such as `ADC_USERNAME_FILE=/run/secrets/adc_username`.
- Generate unique hexadecimal values for the go2rtc API and RTSP passwords.
- Set `ADC_BRIDGE_BIND_ADDRESS` to the Synology LAN address when Homebridge is not attached to the same Docker network.
- Set `ADC_BRIDGE_UID` to the output of `id -u` and `ADC_BRIDGE_GID` to the output of `id -g`. This lets the non-root container read the protected mode-600 configuration without relaxing its permissions.

In `config/config.yaml`, add only the selected camera IDs, safe lowercase stream names, and optional Homebridge motion URL. Add the same stream names to `config/go2rtc.yaml`.

### Migrate an earlier single-branch pilot checkout

Some pilot installations cloned only `agent/harden-synology-deployment`. In
that checkout, `git switch main` fails with `fatal: invalid reference: main`
because the remote fetch rule excludes every other branch.

First confirm `git status --short` prints nothing. Then make the deployment
track only the merged `main` branch:

```bash
cd /volume1/docker/adc-video-bridge
git config remote.origin.fetch \
  '+refs/heads/main:refs/remotes/origin/main'
git fetch origin --prune
git switch -c main --track origin/main
git status -sb
git log -1 --oneline
```

This changes Git metadata and checked-in files only. The ignored `.env`,
`config/config.yaml`, `config/go2rtc.yaml`, and `secrets/` deployment files
remain local. Stop if `git status --short` reports changes and reconcile them
before switching branches.

## Build and start

Synology Container Manager commonly installs Compose at `/var/packages/ContainerManager/target/usr/bin/docker-compose`. Run the installed command with administrative privileges:

```bash
cd /volume1/docker/adc-video-bridge
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose config
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose up --build -d
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose ps
```

The initial build downloads pinned base images and npm packages. No Homebridge configuration is changed by starting the bridge.

Some Synology kernels report that PID limits are unsupported and discard the
Compose `pids_limit`. This warning is nonfatal; the read-only filesystem,
dropped capabilities, and `no-new-privileges` controls remain active.

## Verify before Homebridge

```bash
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose logs --tail=200
curl --fail --user '<api-user>:<api-password>' \
  'http://<synology-ip>:1984/api/frame.jpeg?src=<stream-name>' --output /tmp/frame.jpeg
```

Test `rtsp://<rtsp-user>:<rtsp-password>@<synology-ip>:8554/<stream-name>` in VLC. Continue only after logs report the stream as `streaming` and both snapshot and RTSP tests succeed.

## Homebridge

Install `@homebridge-plugins/homebridge-camera-ffmpeg`, add one camera, and use the authenticated source strings from `docs/SETUP.md`. Keep audio disabled because the bridge currently publishes video only.

After Homebridge restarts, add the new camera accessory to Apple Home if it is running as a child bridge. Confirm live view on the local network before enabling notifications or HomeKit Secure Video.

## Operations

### Update code and rebuild

Pulling source does not replace the running image. Update the checkout, validate
the rendered Compose configuration, and rebuild the service:

```bash
cd /volume1/docker/adc-video-bridge
git status --short
git switch main
git pull --ff-only origin main
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose config
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose \
  up -d --build adc-video-bridge
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose ps
```

Wait for the WebRTC session to establish, then repeat the authenticated snapshot
test and open the camera in Apple Home. A source rebuild also restarts go2rtc,
clearing consumers left behind by an older failed publisher loop. Homebridge
normally does not need to be restarted.

### Routine commands

```bash
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose logs --tail=200
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose restart
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose down
```

`down` removes the container and network but leaves `.env` and configuration files on disk. Do not use `down -v`; no named volume is required.
