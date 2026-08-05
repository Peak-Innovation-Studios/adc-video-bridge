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
