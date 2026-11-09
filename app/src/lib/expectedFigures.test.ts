/**
 * A41.3 security review: what "Zahlen bestätigen" may vouch for. A capture is confirmable only when every engine
 * field can be shown exactly: no control, format or separator character at any depth, and money values that
 * formatMoney shows as they are. SYNTHETIC DATA ONLY.
 */
import { describe, expect, it } from 'vitest';

import { confirmEntryOf, hasUnshowableText, normaliseShown } from './expectedFigures';

const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0);

describe('A41.3: expected figures', () => {
  it('a clean capture is confirmable, with its engine fields exactly as read', () => {
    const fields = { amount: { minor: 1_250, currency: 'CHF' }, vendor_name: 'Wolkenhaus Hosting AG', invoice_date: '2026-10-12' };
    expect(confirmEntryOf('cap_1', 'a'.repeat(64), fields)).toEqual({ captureId: 'cap_1', expected: { sha256: 'a'.repeat(64), fields } });
    expect(hasUnshowableText(fields)).toBe(false);
  });

  it('a hidden character NESTED in a money object, an array or a key fails closed', () => {
    expect(hasUnshowableText({ amount: { minor: 1_250, currency: `CH${RLO}F` } })).toBe(true);
    expect(hasUnshowableText({ vendor_name: ['Acme', `AG${ZWSP}`] })).toBe(true);
    expect(hasUnshowableText({ iban: { [`x${NUL}`]: 'CH93' } })).toBe(true);
    expect(confirmEntryOf('cap_1', 'a'.repeat(64), { amount: { minor: 1_250, currency: `CH${RLO}F` } })).toBeNull();
  });

  it('a money value formatMoney would show differently fails closed: a fractional minor, a malformed currency', () => {
    expect(hasUnshowableText({ amount: { minor: 1_250.5, currency: 'CHF' } })).toBe(true);
    expect(hasUnshowableText({ amount: { minor: 1_250, currency: 'chf' } })).toBe(true);
    expect(hasUnshowableText({ vat_amount: { minor: 93, currency: 'CHFX' } })).toBe(true);
    expect(hasUnshowableText({ amount: '12.50' })).toBe(true);
    expect(hasUnshowableText({ amount: { minor: Number.MAX_SAFE_INTEGER + 1, currency: 'CHF' } })).toBe(true);
    expect(hasUnshowableText({ amount: { minor: -1_250, currency: 'EUR' }, vat_amount: { minor: 0, currency: 'EUR' } })).toBe(false);
  });

  it('the display normalisation replaces the hidden characters and the no-break spaces', () => {
    expect(normaliseShown(`Acme${RLO}AG`)).toBe('Acme AG');
    expect(normaliseShown(`CH93${ZWSP}0076`)).toBe('CH93 0076');
    expect(normaliseShown(`1${String.fromCharCode(0x00a0)}000`)).toBe('1 000');
    expect(normaliseShown(42)).toBe(42);
  });

  it('no sha256 or no engine fields: nothing to confirm', () => {
    expect(confirmEntryOf('cap_1', undefined, { vendor_name: 'Acme' })).toBeNull();
    expect(confirmEntryOf('cap_1', 'a'.repeat(64), null)).toBeNull();
  });
});
