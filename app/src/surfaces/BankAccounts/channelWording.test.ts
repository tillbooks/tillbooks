/**
 * A36 §4.7 (D150): the bank's reason in words. Every code TILL names has a sentence in both locales
 * (a missing key throws here instead of rendering as its dotted path), an unknown code says "Code
 * {code}", and a bank that did not answer names the wire's reason.
 */
import { describe, it, expect } from 'vitest';

import { CATALOG, type Locale } from '../../i18n';
import { KNOWN_RETURN_CODES, returnCodeText } from './channelWording';

function tFor(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const value = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), CATALOG[locale]);
    if (typeof value !== 'string') throw new Error(`${locale}: no message at ${key}`);
    return value.replace(/\{(\w+)\}/g, (whole, name: string) => (params !== undefined && name in params ? String(params[name]) : whole));
  };
}

describe('returnCodeText', () => {
  for (const locale of ['de-CH', 'en'] as Locale[]) {
    it(`${locale}: every known code has its own sentence naming the code`, () => {
      const t = tFor(locale);
      for (const code of KNOWN_RETURN_CODES) {
        const text = returnCodeText(t, { code });
        expect(text).toContain(code);
        expect(text).not.toBe(t('channel.returnCode.other', { code }));
      }
    });
    it(`${locale}: an unknown code and an unanswered bank are worded, nothing is null`, () => {
      const t = tFor(locale);
      expect(returnCodeText(t, { code: '061099' })).toContain('061099');
      expect(returnCodeText(t, { bankReason: 'network' })).toContain('network');
      expect(returnCodeText(t, null)).toBeNull();
      expect(returnCodeText(t, {})).toBeNull();
    });
  }
  it('de-CH says it plainly', () => {
    expect(returnCodeText(tFor('de-CH'), { code: '061099' })).toBe('Die Bank meldet Code 061099.');
  });
});
