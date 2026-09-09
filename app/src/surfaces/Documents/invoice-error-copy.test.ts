/**
 * The guard for a family the i18n key scan cannot see.
 *
 * `i18n.test.tsx` resolves every key passed to `t()` as a STRING LITERAL. The invoice refusal copy
 * is not reached that way: `SendDialog` / `IssueDialog` / `InvoiceArtifacts` call
 * `t(invoiceErrorKey(code))`, so the key is a VALUE in `INVOICE_ERROR_KEYS` and invisible to the
 * scan by construction. That is the same hole `CROSS_CUTTING_ERROR_CODES` and
 * `audit-vocabulary.test.ts` exist to close, applied to this map.
 *
 * It is not a hypothetical. The 2026-07-25 /ux-architect gate found three codes with NO entry here
 * (A11-G1 `send_outcome_unknown`, A11-G3 `needs_qr_bill` and `needs_email_transport`), each falling
 * through to `document.genericError`: "the document could not be updated". For
 * `send_outcome_unknown` that sentence was not merely unhelpful but false in the one direction that
 * matters, since an email may already have reached the customer.
 */
import { describe, it, expect } from 'vitest';

import { CATALOG, type Messages } from '../../i18n';
import { INVOICE_ERROR_KEYS, invoiceErrorKey } from './invoice';

const LOCALES = ['de-CH', 'en'] as const;

/** Resolve a dot-path against a message tree, mirroring the resolver in `i18n/index.tsx`. */
function resolve(tree: Messages, key: string): string | undefined {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

describe('invoice refusal copy', () => {
  it('has real, non-empty copy behind every mapped code, in both locales', () => {
    const codes = Object.keys(INVOICE_ERROR_KEYS);
    expect(codes.length, 'the map is empty: the import broke, not the copy').toBeGreaterThan(10);

    for (const locale of LOCALES) {
      const missing = codes.filter((code) => {
        const copy = resolve(CATALOG[locale], INVOICE_ERROR_KEYS[code]);
        return copy === undefined || copy.trim() === '';
      });
      expect(missing, `mapped codes with no copy in ${locale}`).toEqual([]);
    }
  });

  /**
   * The three the gate caught, named individually. The loop above would catch a missing MESSAGE, but
   * only this catches a missing MAP ENTRY, which is how all three actually failed.
   */
  it('maps the three codes the A11 gate found falling through to the generic banner', () => {
    for (const code of ['send_outcome_unknown', 'needs_qr_bill', 'needs_email_transport']) {
      expect(invoiceErrorKey(code), `${code} still falls through to document.genericError`).not.toBeNull();
    }
  });

  it('tells the two email refusals apart, as US-A11.5 requires in as many words', () => {
    for (const locale of LOCALES) {
      const config = resolve(CATALOG[locale], INVOICE_ERROR_KEYS.needs_email_config);
      const transport = resolve(CATALOG[locale], INVOICE_ERROR_KEYS.needs_email_transport);
      expect(config, `needs_email_config has no copy in ${locale}`).toBeDefined();
      expect(transport, `needs_email_transport has no copy in ${locale}`).toBeDefined();
      expect(transport, `the two email refusals read identically in ${locale}`).not.toEqual(config);
    }
  });

  /**
   * A11-G1's actual defect. `send_outcome_unknown` means a prior attempt REACHED the transport, so
   * the honest copy must not claim nothing happened, and must not tell the user to just retry: the
   * engine refuses the retry on purpose so a human can resolve a possible duplicate by hand.
   */
  it('never tells the user nothing happened when the send outcome is unknown', () => {
    const de = resolve(CATALOG['de-CH'], INVOICE_ERROR_KEYS.send_outcome_unknown) ?? '';
    const en = resolve(CATALOG.en, INVOICE_ERROR_KEYS.send_outcome_unknown) ?? '';

    // It admits the uncertainty rather than asserting an outcome in either direction.
    expect(de).toMatch(/möglicherweise/);
    expect(en).toMatch(/may/);
    // And it says the mail already left, which is the fact the generic banner denied.
    expect(de).toMatch(/erreicht/);
    expect(en).toMatch(/reached/);
  });
});
