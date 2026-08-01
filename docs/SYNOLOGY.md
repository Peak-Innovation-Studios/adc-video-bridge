# Synology Container Manager Deployment

This deployment keeps runtime configuration under `/volume1/docker/adc-video-bridge` and uses the Compose project included in the repository.

## Prepare the project

Clone or copy the repository to the Synology, then create local configuration:

```bash
cd /volume1/docker/adc-video-bridge
mkdir -p secrets
chmod 700 secrets
cp .env.example .env
cp config/config.example.yaml config/config.yaml
cp config/go2rtc.example.yaml config/go2rtc.yaml
chmod 600 .env config/config.yaml config/go2rtc.yaml
```

In `.env`:

- Set the Alarm.com login, or create mode-600 files under `secrets/` and set the corresponding paths such as `ADC_USERNAME_FILE=/run/secrets/adc_username`.
- Generate unique hexadecimal values for the go2rtc API and RTSP passwords.
- Set `ADC_BRIDGE_BIND_ADDRESS` to the Synology LAN address when Homebridge is not attached to the same Docker network.

In `config/config.yaml`, add only the selected camera IDs, safe lowercase stream names, and optional Homebridge motion URL. Add the same stream names to `config/go2rtc.yaml`.

## Build and start

Synology Container Manager commonly installs Compose at `/var/packages/ContainerManager/target/usr/bin/docker-compose`. Run the installed command with administrative privileges:

```bash
cd /volume1/docker/adc-video-bridge
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose config
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose up --build -d
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose ps
```

The initial build downloads pinned base images and npm packages. No Homebridge configuration is changed by starting the bridge.

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

```bash
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose logs --tail=200
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose restart
sudo /var/packages/ContainerManager/target/usr/bin/docker-compose down
```

`down` removes the container and network but leaves `.env` and configuration files on disk. Do not use `down -v`; no named volume is required.
