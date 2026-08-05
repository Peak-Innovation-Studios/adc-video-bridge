import { describe, it, expect, afterEach } from 'vitest';
import pino from 'pino';
import { scrubRtspCredentials, logger, createChildLogger } from './logger.js';

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

/**
 * End-to-end coverage of the configured pino instance, not of the pure helper
 * above. `scrubRtspCredentials` being correct proves nothing about whether the
 * logger actually calls it: deleting the `hooks.logMethod` block leaves every
 * pure-function test green while un-redacting every message-string path in the
 * codebase (`log.info('... %s', url)` in index.ts, ffmpeg error messages, ...).
 * These tests drive the real exported logger and read what it emits.
 */
describe('logger redaction wiring', () => {
  const streamSym = pino.symbols.streamSym;
  const original = (logger as unknown as Record<symbol, unknown>)[streamSym];

  /** Swap the real destination for a capturing one and return the lines written. */
  function capture(emit: () => void): string {
    const written: string[] = [];
    (logger as unknown as Record<symbol, unknown>)[streamSym] = {
      write: (chunk: string) => {
        written.push(chunk);
      },
    };
    try {
      emit();
    } finally {
      (logger as unknown as Record<symbol, unknown>)[streamSym] = original;
    }
    return written.join('');
  }

  afterEach(() => {
    (logger as unknown as Record<symbol, unknown>)[streamSym] = original;
  });

  it('scrubs credentials from a message string', () => {
    const out = capture(() => {
      logger.info('publishing to rtsp://rtspuser:s3cret@192.168.7.42:8554/front');
    });

    expect(out).not.toBe('');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('rtsp://[REDACTED]@192.168.7.42:8554/front');
  });

  it('scrubs credentials from printf-style interpolation arguments', () => {
    // index.ts logs this way (`log.fatal('Config error: %s', message)`), so the
    // credential can arrive in args[1] rather than args[0].
    const out = capture(() => {
      logger.error('ffmpeg failed: %s', 'cannot open rtsp://rtspuser:s3cret@192.168.7.42:8554/front');
    });

    expect(out).not.toContain('s3cret');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs credentials logged through a child logger', () => {
    // Every module logs through createChildLogger, so inheritance of the hook
    // is the case that actually matters in production.
    const child = createChildLogger('wiring-test');
    const out = capture(() => {
      child.warn('retrying rtsp://rtspuser:s3cret@192.168.7.42:8554/front');
    });

    expect(out).not.toContain('s3cret');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('wiring-test');
  });

  it('leaves a message without credentials untouched', () => {
    const out = capture(() => {
      logger.info('connected to rtsp://192.168.7.42:8554/front');
    });

    expect(out).toContain('rtsp://192.168.7.42:8554/front');
    expect(out).not.toContain('[REDACTED]');
  });

  it('still redacts named credential fields on logged objects', () => {
    // The `redact.paths` half of the configuration — independent of the hook,
    // and deletable on its own.
    const out = capture(() => {
      logger.info(
        { rtspUrl: 'rtsp://rtspuser:s3cret@192.168.7.42:8554/front', password: 'hunter2' },
        'status',
      );
    });

    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[REDACTED]');
  });
});
