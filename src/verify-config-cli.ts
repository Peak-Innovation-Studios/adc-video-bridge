import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyConfigs, parseEnvFile } from './verify-config.js';

/**
 * CLI for `verifyConfigs`. Kept separate from the logic so the checks stay
 * importable by tests without a module-load side effect.
 *
 * Defaults to the current directory; pass a deployment root to check a
 * different one:
 *   npm run verify:config
 *   npm run verify:config -- /volume1/docker/adc-video-bridge
 */
function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

const root = resolve(process.argv[2] ?? process.cwd());
const configYaml = readIfPresent(resolve(root, 'config', 'config.yaml'));
const go2rtcYaml = readIfPresent(resolve(root, 'config', 'go2rtc.yaml'));
const envText = readIfPresent(resolve(root, '.env'));

const missing = [
  configYaml ? '' : 'config/config.yaml',
  go2rtcYaml ? '' : 'config/go2rtc.yaml',
  envText ? '' : '.env',
].filter(Boolean);

if (missing.length > 0) {
  console.error(`Not found under ${root}: ${missing.join(', ')}`);
  console.error('Pass the deployment root, e.g. npm run verify:config -- /volume1/docker/adc-video-bridge');
  process.exit(2);
}

const result = verifyConfigs({ configYaml, go2rtcYaml, env: parseEnvFile(envText) });

// ⚠️ Prints FINDINGS only. Stream sources are matched, never echoed — a stream
// URL carries the camera password, and this output gets pasted into chats.
for (const line of result.blocking) console.log(`  BLOCKING  ${line}`);
for (const line of result.warnings) console.log(`  warning   ${line}`);
for (const line of result.passed) console.log(`  ok        ${line}`);
console.log(
  `\n${result.blocking.length} blocking, ${result.warnings.length} warnings, ${result.passed.length} checks passed`,
);
process.exit(result.blocking.length > 0 ? 1 : 0);
