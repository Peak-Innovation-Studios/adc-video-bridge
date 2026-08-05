# Native HKSV — Phase 0 (split-ready bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bridge able to reach a go2rtc that lives in a *different container* — configurable host plus authentication — and build the two images and compose topology, without changing production behaviour.

**Architecture:** Today the bridge and go2rtc share one container and talk over loopback, which go2rtc exempts from authentication. Splitting them moves that traffic to the host LAN address, where go2rtc returns 401. So Phase 0 makes the go2rtc location configurable, adds credentials to both the API client and the RTSP push URL, and produces two images plus a two-service compose file. Deploying it is Phase 1 and is out of scope here.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20, vitest, Docker Compose, go2rtc (self-built fork).

## Global Constraints

- **Never log or commit credentials.** RTSP URLs contain a username and password; they must be redacted anywhere they could reach a log. `src/utils/logger.ts` already has redaction — extend it, don't bypass it.
- **The two services must not share an env file.** `go2rtc` receives only `GO2RTC_*` and `HKSV_PIN`. `ADC_USERNAME` / `ADC_PASSWORD` / `ADC_MFA_TOKEN` stay with the bridge only.
- **`listen:` in `go2rtc.yaml` must be an explicit address, never `:1984`.** Under `network_mode: host` this is the only control keeping 1984/8554 off other interfaces.
- **All existing hardening survives on both containers:** `read_only`, `cap_drop: ALL`, `no-new-privileges`, non-root, `pids_limit: 256`, tmpfs `/tmp`, log rotation.
- **Pinned fork commit:** `506cfa7df508058b0d46a3457130a9cd3a647ae8` (`skrashevich/go2rtc`, branch `hksv`, base `master`). Pin the **SHA**, never the branch.
- **The existing suite must stay green: 12 files / 180 tests.** Run `npx vitest run`, not `npm test`, and expect 180+ as tasks add tests.
- Do not enable HKSV in this phase. Phase 0 must be behaviourally identical to today.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | Owns the go2rtc location (`apiUrl`) and credentials; exports a derived RTSP base URL so host/port live in one place |
| `src/config.test.ts` | Covers defaults, overrides, credential handling, and that API and RTSP agree on host |
| `src/go2rtc/go2rtc-api.ts` | Adds HTTP Basic auth to API calls |
| `src/go2rtc/go2rtc-api.test.ts` | Covers the auth header |
| `src/index.ts` | Stops hardcoding `127.0.0.1`; uses the derived RTSP base URL |
| `src/utils/logger.ts` | Redacts RTSP credentials |
| `entrypoint.sh` | Loses the go2rtc launch; ordering moves to compose `depends_on` |
| `Dockerfile` | Bridge only — runtime base moves off `alexxit/go2rtc`, gains its own ffmpeg |
| `Dockerfile.go2rtc` | New — pinned-source build of the HKSV fork |
| `docker-compose.yml` | Two services, env separation, writable go2rtc config mount |
| `docs/SECURITY_AUDIT.md` | Records the pinning delta as an accepted risk |
| `docs/INVARIANTS.md` | Records the revert trigger when #2130 ships |

---

### Task 1: Single source of truth for the go2rtc location

The RTSP host is currently hardcoded while the API URL is configurable. Derive both from `apiUrl` so they cannot drift.

**Files:**
- Modify: `src/config.ts` (`DEFAULT_CONFIG.go2rtc.apiUrl`, add exported helper)
- Modify: `src/index.ts:43`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: existing `AppConfig`, `loadConfig()`.
- Produces: `export function go2rtcRtspBaseUrl(config: AppConfig): string` returning e.g. `rtsp://user:pass@192.168.7.42:8554`. Task 3 extends it with credentials; Task 2 uses `config.go2rtc` for auth.

- [ ] **Step 1: Write the failing test**

Add to `src/config.test.ts`, inside `describe('loadConfig', ...)`:

```typescript
  it('derives the RTSP base URL from the go2rtc API URL host', () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('go2rtc:\n  apiUrl: "http://192.168.7.42:1984"\n  rtspPort: 8554\n');
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';

    const config = loadConfig();

    expect(go2rtcRtspBaseUrl(config)).toBe('rtsp://192.168.7.42:8554');
  });

  it('defaults the RTSP base URL to loopback, matching pre-split behaviour', () => {
    existsSync.mockReturnValue(false);
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';

    const config = loadConfig();

    expect(config.go2rtc.apiUrl).toBe('http://127.0.0.1:1984');
    expect(go2rtcRtspBaseUrl(config)).toBe('rtsp://127.0.0.1:8554');
  });
```

Update the import on line 2 to `import { loadConfig, go2rtcRtspBaseUrl } from './config.js';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `go2rtcRtspBaseUrl is not a function`.

- [ ] **Step 3: Implement**

In `src/config.ts`, change the default so loopback is explicit (avoids `localhost` resolving to `::1`, which ffmpeg handles differently):

```typescript
  go2rtc: {
    apiUrl: 'http://127.0.0.1:1984',
    rtspPort: 8554,
  },
```

Add at the end of the file:

```typescript
/**
 * The RTSP base URL ffmpeg publishes to. Derived from `apiUrl` rather than
 * configured separately: both address the same go2rtc, and two keys could
 * drift apart silently after the container split.
 */
export function go2rtcRtspBaseUrl(config: AppConfig): string {
  const host = new URL(config.go2rtc.apiUrl).hostname;
  return `rtsp://${host}:${config.go2rtc.rtspPort}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in `index.ts`**

Replace line 43:

```typescript
  const rtspBaseUrl = go2rtcRtspBaseUrl(config);
```

and add `go2rtcRtspBaseUrl` to the existing `./config.js` import.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npm run build`
Expected: build clean, all tests pass (182).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts src/index.ts
git commit -m "Derive the RTSP base URL from the go2rtc API URL"
```

---

### Task 2: Authenticate the go2rtc API client

`Go2rtcApi` sends no credentials. That works only because loopback is exempt; from another container every call 401s.

**Files:**
- Modify: `src/config.ts` (add `apiUsername` / `apiPassword`)
- Modify: `src/go2rtc/go2rtc-api.ts`
- Modify: `src/index.ts` (pass credentials)
- Test: `src/go2rtc/go2rtc-api.test.ts`

**Interfaces:**
- Consumes: `AppConfig.go2rtc` from Task 1.
- Produces: `new Go2rtcApi(baseUrl, credentials?)` where `credentials` is `{ username: string; password: string } | undefined`.

- [ ] **Step 1: Write the failing test**

Create `src/go2rtc/go2rtc-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Go2rtcApi } from './go2rtc-api.js';

describe('Go2rtcApi authentication', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends HTTP Basic credentials when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const api = new Go2rtcApi('http://192.168.7.42:1984', { username: 'u', password: 'p' });
    await api.getStreams();

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('sends no Authorization header when no credentials are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const api = new Go2rtcApi('http://127.0.0.1:1984');
    await api.getStreams();

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers?.Authorization).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/go2rtc/go2rtc-api.test.ts`
Expected: FAIL — no `Authorization` header is sent.

- [ ] **Step 3: Implement**

In `src/go2rtc/go2rtc-api.ts`:

```typescript
export interface Go2rtcCredentials {
  username: string;
  password: string;
}

export class Go2rtcApi {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly baseUrl: string,
    credentials?: Go2rtcCredentials,
  ) {
    this.headers = credentials
      ? {
          Authorization:
            'Basic ' +
            Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
        }
      : {};
  }
```

Then add `headers: this.headers,` to the `fetch` init object in **both** `isHealthy()` and `getStreams()`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/go2rtc/go2rtc-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire config and callers**

In `src/config.ts`, extend the interface and default:

```typescript
  go2rtc: {
    apiUrl: string;
    rtspPort: number;
    apiUsername?: string;
    apiPassword?: string;
    rtspUsername?: string;
    rtspPassword?: string;
  };
```

In `loadConfig()`'s return, read them via the existing `readEnvironmentSecret` helper so `_FILE` variants work:

```typescript
    go2rtc: {
      ...DEFAULT_CONFIG.go2rtc,
      ...fileConfig.go2rtc,
      apiUsername: readEnvironmentSecret('GO2RTC_API_USERNAME') ?? fileConfig.go2rtc?.apiUsername,
      apiPassword: readEnvironmentSecret('GO2RTC_API_PASSWORD') ?? fileConfig.go2rtc?.apiPassword,
      rtspUsername: readEnvironmentSecret('GO2RTC_RTSP_USERNAME') ?? fileConfig.go2rtc?.rtspUsername,
      rtspPassword: readEnvironmentSecret('GO2RTC_RTSP_PASSWORD') ?? fileConfig.go2rtc?.rtspPassword,
    },
```

In `src/index.ts`, pass them where `Go2rtcApi` is constructed:

```typescript
  const go2rtcApi = new Go2rtcApi(
    config.go2rtc.apiUrl,
    config.go2rtc.apiUsername && config.go2rtc.apiPassword
      ? { username: config.go2rtc.apiUsername, password: config.go2rtc.apiPassword }
      : undefined,
  );
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npm run build`
Expected: build clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/go2rtc/go2rtc-api.ts src/go2rtc/go2rtc-api.test.ts src/index.ts
git commit -m "Authenticate go2rtc API calls, which loopback exemption hid"
```

---

### Task 3: Credentials in the RTSP push URL, redacted in logs

**Files:**
- Modify: `src/config.ts` (`go2rtcRtspBaseUrl`)
- Modify: `src/utils/logger.ts` (redaction)
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: `config.go2rtc.rtspUsername` / `rtspPassword` from Task 2.
- Produces: `go2rtcRtspBaseUrl()` now embeds credentials when present.

- [ ] **Step 1: Write the failing test**

Add to `src/config.test.ts`:

```typescript
  it('embeds RTSP credentials in the base URL when configured', () => {
    existsSync.mockReturnValue(false);
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    process.env.GO2RTC_RTSP_USERNAME = 'rtspuser';
    process.env.GO2RTC_RTSP_PASSWORD = 'rtsp pass/word';

    const config = loadConfig();

    expect(go2rtcRtspBaseUrl(config)).toBe('rtsp://rtspuser:rtsp%20pass%2Fword@127.0.0.1:8554');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — credentials absent from the URL.

- [ ] **Step 3: Implement**

Replace `go2rtcRtspBaseUrl` in `src/config.ts`:

```typescript
export function go2rtcRtspBaseUrl(config: AppConfig): string {
  const host = new URL(config.go2rtc.apiUrl).hostname;
  const { rtspUsername, rtspPassword } = config.go2rtc;
  // encodeURIComponent so a password containing / : @ cannot break the URL.
  const auth =
    rtspUsername && rtspPassword
      ? `${encodeURIComponent(rtspUsername)}:${encodeURIComponent(rtspPassword)}@`
      : '';
  return `rtsp://${auth}${host}:${config.go2rtc.rtspPort}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Redact credentials in logs**

⚠️ `pino`'s existing `redact.paths` matches **object keys only**. A credentialed URL passed as a *message argument* — which is how `camera-stream.ts` logs the RTSP target — is not covered by it. That needs a `logMethod` hook.

Write the failing test first, `src/utils/logger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { scrubRtspCredentials } from './logger.js';

describe('scrubRtspCredentials', () => {
  it('removes credentials from an RTSP URL', () => {
    expect(scrubRtspCredentials('publishing to rtsp://user:s3cret@192.168.7.42:8554/front'))
      .toBe('publishing to rtsp://[REDACTED]@192.168.7.42:8554/front');
  });

  it('leaves a URL without credentials untouched', () => {
    expect(scrubRtspCredentials('rtsp://192.168.7.42:8554/front'))
      .toBe('rtsp://192.168.7.42:8554/front');
  });

  it('passes non-strings through unchanged', () => {
    expect(scrubRtspCredentials(42 as unknown as string)).toBe(42);
  });
});
```

Run: `npx vitest run src/utils/logger.test.ts` → FAIL (`scrubRtspCredentials is not a function`).

Then in `src/utils/logger.ts`, add above the `logger` definition:

```typescript
/** `rtsp://user:pass@host` → `rtsp://[REDACTED]@host`. Non-strings pass through. */
export function scrubRtspCredentials<T>(value: T): T {
  if (typeof value !== 'string') return value;
  return value.replace(/(rtsps?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@') as unknown as T;
}
```

Add `'rtspUrl'`, `'*.rtspUrl'`, `'rtspBaseUrl'`, `'*.rtspBaseUrl'` to the existing `redact.paths` array, and add this option to the `pino({...})` call:

```typescript
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map(scrubRtspCredentials) as typeof args);
    },
  },
```

Run: `npx vitest run src/utils/logger.test.ts` → PASS.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npm run build`
Expected: build clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts src/utils/logger.ts src/utils/logger.test.ts
git commit -m "Authenticate the RTSP push and redact credentials from logs"
```

---

### Task 4: Simplify `entrypoint.sh`

Ordering moves from an in-container wait loop to compose's `depends_on`, which is what an orchestrator is for.

**Files:**
- Modify: `entrypoint.sh`

- [ ] **Step 1: Rewrite**

```sh
#!/bin/sh
set -e

# go2rtc now runs in its own container. Startup ordering is compose's job
# (depends_on: service_healthy), and if go2rtc is briefly unavailable the
# camera retry ladder and circuit breaker already handle it.
exec node dist/index.js
```

The `GO2RTC_*` guards are removed here because those variables now belong to the go2rtc service; the bridge's own credentials are validated by `loadConfig()`.

- [ ] **Step 2: Verify it is still executable and valid**

Run: `sh -n entrypoint.sh && test -x entrypoint.sh && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add entrypoint.sh
git commit -m "Drop the go2rtc launch from the bridge entrypoint"
```

---

### Task 5: Bridge Dockerfile — off the go2rtc base

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Change the runtime stage**

Replace the `FROM alexxit/go2rtc...` runtime stage with the **same digest-pinned node image already used for building**, and install the bridge's own ffmpeg:

```dockerfile
# Stage 2: Runtime — go2rtc now lives in its own container, so the bridge
# carries only what it needs: node, and the ffmpeg it spawns to mux RTP→RTSP.
FROM node:20.19.5-alpine3.22@sha256:6178e78b972f79c335df281f4b7674a2d85071aae2af020ffa39f0a770265435

RUN apk add --no-cache ffmpeg curl && \
    addgroup -S app && adduser -S app -G app
```

Delete the `EXPOSE 1984 8554` line — the bridge listens on nothing.

- [ ] **Step 2: Build it**

Run: `docker build -t adc-bridge-test .`
Expected: builds clean; `docker run --rm --entrypoint ffmpeg adc-bridge-test -version` prints a version.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "Bridge image: drop the go2rtc base, carry its own ffmpeg"
```

---

### Task 6: `Dockerfile.go2rtc` — pinned-source build of the HKSV fork

**Files:**
- Create: `Dockerfile.go2rtc`

- [ ] **Step 1: Resolve the base image digests**

Run:

```bash
docker buildx imagetools inspect golang:1.23-alpine | head -5
docker buildx imagetools inspect alpine:3.22 | head -5
```

Record both `Digest:` values; use them literally in the next step. Do not proceed with an unpinned tag.

- [ ] **Step 2: Create the file**

```dockerfile
# HKSV is not in an official go2rtc release yet (AlexxIT/go2rtc#2130 is open),
# so go2rtc is built from the PR branch. The upstream digest pin is replaced by
# pinning what is underneath: the toolchain by digest, the source by commit SHA.
# 🔴 REVERT TRIGGER: when #2130 ships, delete this build stage and return to the
# official digest-pinned alexxit/go2rtc image.
FROM golang:1.23-alpine@sha256:<GOLANG-DIGEST> AS build
ARG GO2RTC_REF=506cfa7df508058b0d46a3457130a9cd3a647ae8
RUN apk add --no-cache git && \
    git clone https://github.com/skrashevich/go2rtc /src && \
    git -C /src checkout "$GO2RTC_REF"
RUN cd /src && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /go2rtc ./cmd/go2rtc

FROM alpine:3.22@sha256:<ALPINE-DIGEST>
# ffmpeg is for the snapshot provider (api/frame.jpeg), NOT for HKSV —
# HKSV muxes fMP4 in-process with zero ffmpeg.
RUN apk add --no-cache ffmpeg curl && \
    addgroup -S app && adduser -S app -G app
COPY --from=build /go2rtc /usr/local/bin/go2rtc
USER app
ENTRYPOINT ["go2rtc", "-config", "/app/config/go2rtc.yaml"]
```

- [ ] **Step 3: Build and sanity-check**

Run: `docker build -f Dockerfile.go2rtc -t go2rtc-hksv-test .`
Then: `docker run --rm --entrypoint go2rtc go2rtc-hksv-test --version`
Expected: builds clean and prints a version. Record which upstream go2rtc release the commit is based on; note it in the spec's open questions.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.go2rtc
git commit -m "Add a pinned-source build of the HKSV go2rtc fork"
```

---

### Task 7: Two-service compose topology

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Rewrite as two services**

Key requirements, each of which is a Global Constraint:

```yaml
services:
  go2rtc:
    build: { context: ., dockerfile: Dockerfile.go2rtc }
    container_name: go2rtc
    restart: unless-stopped
    init: true
    user: "${ADC_BRIDGE_UID:-1000}:${ADC_BRIDGE_GID:-1000}"
    # Host networking: HomeKit needs mDNS multicast, which bridge networking
    # does not forward. `ports:` is IGNORED here — go2rtc.yaml's `listen:` is
    # the ONLY thing binding these services to one address.
    network_mode: host
    # NOT env_file: .env — that holds the Alarm.com credentials.
    environment:
      GO2RTC_API_USERNAME: ${GO2RTC_API_USERNAME}
      GO2RTC_API_PASSWORD: ${GO2RTC_API_PASSWORD}
      GO2RTC_RTSP_USERNAME: ${GO2RTC_RTSP_USERNAME}
      GO2RTC_RTSP_PASSWORD: ${GO2RTC_RTSP_PASSWORD}
      GO2RTC_BIND: ${ADC_BRIDGE_BIND_ADDRESS:-127.0.0.1}
    volumes:
      # Writable: go2rtc persists HomeKit pairings, device_id and
      # device_private back into this file. It is a secret — mode 600.
      - ./config/go2rtc.yaml:/app/config/go2rtc.yaml:rw
    read_only: true
    tmpfs: [ "/tmp:rw,noexec,nosuid,nodev,size=128m" ]
    cap_drop: [ ALL ]
    security_opt: [ "no-new-privileges:true" ]
    pids_limit: 256
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "curl", "--fail", "--silent", "--max-time", "3",
             "-u", "${GO2RTC_API_USERNAME}:${GO2RTC_API_PASSWORD}",
             "http://${ADC_BRIDGE_BIND_ADDRESS:-127.0.0.1}:1984/api/streams"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  adc-video-bridge:
    build: .
    container_name: adc-video-bridge
    restart: unless-stopped
    init: true
    user: "${ADC_BRIDGE_UID:-1000}:${ADC_BRIDGE_GID:-1000}"
    depends_on:
      go2rtc: { condition: service_healthy }
    env_file: [ "${ADC_BRIDGE_ENV_FILE:-.env}" ]
    environment:
      NODE_ENV: production
    volumes:
      - ./config:/app/config:ro
      - ./secrets:/run/secrets:ro
    # No ports: the bridge listens on nothing after the split.
    read_only: true
    tmpfs: [ "/tmp:rw,noexec,nosuid,nodev,size=128m" ]
    cap_drop: [ ALL ]
    security_opt: [ "no-new-privileges:true" ]
    pids_limit: 256
    stop_grace_period: 30s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

⚠️ The bridge has **no healthcheck** — see the spec's "Known gap". Do not point one at go2rtc; it would prove the wrong thing.

- [ ] **Step 2: Validate**

Run: `docker compose config >/dev/null && echo VALID`
Expected: `VALID`.

Then confirm the credential separation holds:

```bash
docker compose config | awk '/^  go2rtc:/,/^  adc-video-bridge:/' | grep -c ADC_ 
```
Expected: `0`. Any non-zero result means Alarm.com credentials reached the host-networked container — stop and fix.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "Split compose into go2rtc and bridge services"
```

---

### Task 8: Record the security deltas

**Files:**
- Modify: `docs/SECURITY_AUDIT.md`
- Modify: `docs/INVARIANTS.md`

- [ ] **Step 1: Update `SECURITY_AUDIT.md`**

Rewrite the base-image pinning control to describe the new shape: the bridge stays on a digest-pinned `node:20.19.5-alpine3.22`; go2rtc is built from source with a digest-pinned toolchain and a commit-SHA-pinned source, recorded as an **accepted, documented delta** rather than a silent loss. Add the two new invariants: explicit `listen:` addresses, and the go2rtc config file being a secret (mode 600, HomeKit private keys, on a volume whose default ACL is 0777).

- [ ] **Step 2: Update `INVARIANTS.md`**

Beside the standing HKSV decision, add the **revert trigger**: when #2130 merges and ships, delete the build stage in `Dockerfile.go2rtc` and return to the official digest-pinned image. Without this the self-build outlives its justification.

- [ ] **Step 3: Commit**

```bash
git add docs/SECURITY_AUDIT.md docs/INVARIANTS.md
git commit -m "Record the pinning delta and the revert trigger"
```

---

## Out of scope for Phase 0

- **Deploying any of this** — that is Phase 1, needs sudo on Kaikoura, and is verified by the parity checks in the spec.
- **Enabling HKSV** (`hksv:` block, pin, pairing) — Phase 2, blocked on a stable camera.
- **The `motion: api` vs `motion: detect` decision** — spec open question, decide before Phase 2.
- **A bridge healthcheck** — the gap is declared deliberately; a status endpoint is a separate change.
