import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const allowedPackages = new Set(['ip', 'werift', 'werift-ice']);
const allowedAdvisories = new Set([1101851]); // GHSA-2p57-rm9w-gvfp

function javascriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...javascriptFiles(path));
    else if (entry.endsWith('.js')) files.push(path);
  }
  return files;
}

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: false,
});

if (!audit.stdout) {
  process.stderr.write(audit.stderr || 'npm audit produced no JSON output\n');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write('Unable to parse npm audit JSON output\n');
  process.exit(1);
}

if (report.error || report.auditReportVersion !== 2 || !report.metadata) {
  process.stderr.write(`npm audit failed: ${report.error?.summary ?? 'unexpected report format'}\n`);
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const packages = Object.keys(vulnerabilities);
const advisoryIds = new Set();
for (const vulnerability of Object.values(vulnerabilities)) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === 'object' && typeof via.source === 'number') advisoryIds.add(via.source);
  }
}

const unexpectedPackages = packages.filter((name) => !allowedPackages.has(name));
const unexpectedAdvisories = [...advisoryIds].filter((id) => !allowedAdvisories.has(id));
if (unexpectedPackages.length || unexpectedAdvisories.length) {
  process.stderr.write(
    `Unexpected production advisories: packages=${unexpectedPackages.join(',') || 'none'} ` +
      `advisories=${unexpectedAdvisories.join(',') || 'none'}\n`,
  );
  process.exit(1);
}

if (packages.length > 0) {
  // The only accepted advisory is for ip.isPublic() misclassifying unusual
  // addresses. werift-ice 0.2.2 uses ip only for loopback checks and STUN
  // address encoding/decoding. Fail if that assumption changes.
  const weriftIceRoot = join(process.cwd(), 'node_modules', 'werift-ice', 'lib');
  const usesAffectedApi = javascriptFiles(weriftIceRoot).some((path) =>
    /\.isPublic\s*\(/.test(readFileSync(path, 'utf8')),
  );
  if (usesAffectedApi) {
    process.stderr.write('werift-ice now calls vulnerable ip.isPublic(); remove the audit exception\n');
    process.exit(1);
  }

  process.stdout.write(
    'Production audit passed with documented GHSA-2p57-rm9w-gvfp exception; affected API is unused.\n',
  );
} else {
  process.stdout.write('Production audit passed with no vulnerabilities.\n');
}
