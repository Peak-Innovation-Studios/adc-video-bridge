import { describe, it, expect } from 'vitest';
import { calcSetupId, generateSetupUri, decodeSetupUri, formatPin, CATEGORY } from './setup-uri.js';

describe('calcSetupId', () => {
  it('is derived from the stream name, not random', () => {
    expect(calcSetupId('front')).toBe(calcSetupId('front'));
    expect(calcSetupId('front')).not.toBe(calcSetupId('kitchen'));
    expect(calcSetupId('front')).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('generateSetupUri', () => {
  it('round-trips category, pin and setup id', () => {
    const uri = generateSetupUri(CATEGORY.camera, '11223344', 'ABCD');
    const decoded = decodeSetupUri(uri);
    expect(decoded).toMatchObject({
      category: 17,
      categoryName: 'IP Camera',
      pin: '112-23-344',
      setupId: 'ABCD',
      supportsIp: true,
    });
  });

  it('accepts a dashed pin identically to an undashed one', () => {
    expect(generateSetupUri(17, '112-23-344', 'ABCD')).toBe(generateSetupUri(17, '11223344', 'ABCD'));
  });

  it('produces "X-HM://" plus exactly 13 characters', () => {
    const uri = generateSetupUri(17, '11223344', 'ABCD');
    expect(uri).toMatch(/^X-HM:\/\/[0-9A-Z]{9}[0-9A-Z]{4}$/);
  });

  /**
   * 🔴 The bug this whole module exists to prevent. A generator that defaults to
   * the bridge category produces a QR with the RIGHT pin that makes the Home app
   * open the bridge dialog and hang forever, because go2rtc advertises ci=17 and
   * no bridge ever appears. Observed on real labels 2026-08-07.
   */
  it('encodes bridge and camera categories distinguishably', () => {
    const asCamera = generateSetupUri(CATEGORY.camera, '11223344', 'ABCD');
    const asBridge = generateSetupUri(CATEGORY.bridge, '11223344', 'ABCD');
    expect(asCamera).not.toBe(asBridge);
    expect((decodeSetupUri(asBridge) as { categoryName: string }).categoryName).toBe('Bridge');
    expect((decodeSetupUri(asCamera) as { categoryName: string }).categoryName).toBe('IP Camera');
  });
});

describe('decodeSetupUri', () => {
  it('rejects anything that is not a setup URI', () => {
    // A QR holding only the digits is the other real-world failure.
    expect(decodeSetupUri('112-23-344')).toEqual({ error: 'not a valid X-HM:// setup URI' });
    expect(decodeSetupUri('X-HM://tooshort')).toHaveProperty('error');
  });
});

describe('formatPin', () => {
  it('groups digits the way the Home app displays them', () => {
    expect(formatPin('11223344')).toBe('112-23-344');
    expect(formatPin('112-23-344')).toBe('112-23-344');
  });
});
