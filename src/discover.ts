import { loadConfig } from './config.js';
import { AlarmAuth } from './auth/alarm-auth.js';
import { formatRow, rowWidth } from './utils/table.js';

const COLUMN_WIDTHS = [20, 20, 16, 10];

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Config error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const auth = new AlarmAuth(config.alarm.username, config.alarm.password, config.alarm.mfaToken);

  console.log('Logging in to Alarm.com...');
  await auth.authenticate();

  console.log('Fetching cameras...\n');
  const cameras = await auth.getCameraList();

  if (cameras.length === 0) {
    console.log('No cameras found on this account.');
    auth.destroy();
    return;
  }

  // Print table
  console.log('Cameras found:\n');
  console.log('  ' + formatRow(['ID', 'Description', 'Model', 'Live View'], COLUMN_WIDTHS));
  console.log('  ' + '-'.repeat(rowWidth(COLUMN_WIDTHS)));
  for (const cam of cameras) {
    console.log(
      '  ' +
        formatRow(
          [cam.id, cam.description, cam.deviceModel, cam.supportsLiveView ? 'yes' : 'no'],
          COLUMN_WIDTHS,
        ),
    );
  }

  // Generate YAML snippets
  const liveViewCameras = cameras.filter((c) => c.supportsLiveView);

  if (liveViewCameras.length > 0) {
    const toStreamName = (desc: string, id: string) =>
      desc.toLowerCase().replace(/\s+/g, '-') || `camera-${id}`;

    console.log('\n\n--- config/config.yaml cameras section ---\n');
    console.log('cameras:');
    for (const cam of liveViewCameras) {
      const name = toStreamName(cam.description, cam.id);
      console.log(`  - id: "${cam.id}"`);
      console.log(`    name: "${name}"`);
      console.log(`    quality: "hd"`);
    }

    console.log('\n\n--- config/go2rtc.yaml streams section ---\n');
    console.log('streams:');
    for (const cam of liveViewCameras) {
      const name = toStreamName(cam.description, cam.id);
      console.log(`  ${name}: ""`);
    }
  }

  auth.destroy();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
