/**
 * `postedBaseFigures`, the one place the Studio decides a document HAS base-currency figures to show.
 *
 * Every case below runs against `document-fx.fixture.json`, which
 * `test/sales/studio-fx-document-fixture.test.mjs` and `test/sales/studio-base-vat-fixture.test.mjs`
 * pin to the live engine, keys and kinds, with every figure read back out of the posted `journal_line`
 * rows. So these are not assertions about a shape someone imagined: they are assertions about the
 * shape the engine proved it sends, which is the only kind worth writing after four Studio defects
 * shipped from a key that was never on the wire.
 *
 * The guard was `postedBaseTotal` while the group was about the total alone. `baseTaxMinor` travels
 * under the same `statesConversionBasis` gate, so the Studio still branches ONCE and gets all four
 * keys or none; the name changed because a function that hands back the franc VAT is no longer about
 * a total.
 */
import { describe, it, expect } from 'vitest';

import { postedBaseFigures, type DocumentDto } from './model';
import fx from './document-fx.fixture.json';

const arm = (key: keyof typeof fx): DocumentDto => fx[key] as unknown as DocumentDto;

/** Half away from zero, the repo's P2 rounding, so the forbidden shortcut is computed fairly. */
const roundHalfAwayFromZero = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

describe('postedBaseFigures', () => {
  it('reports the posted figures for an issued foreign-currency invoice', () => {
    // Read straight off the fixture, never restated as a literal: a hand-typed 152616 here would go
    // on passing after the engine changed what it converts.
    expect(postedBaseFigures(arm('issuedForeign'))).toEqual({
      totalBaseMinor: fx.issuedForeign.totalBaseMinor,
      fxRate: fx.issuedForeign.fxRate,
      baseCurrency: fx.issuedForeign.baseCurrency,
      baseTaxMinor: fx.issuedForeign.baseTaxMinor,
    });
  });

  it('reports nothing for a base-currency invoice, where the engine sends no FX group at all', () => {
    expect(postedBaseFigures(arm('issuedBase'))).toBeNull();
  });

  it('reports the figures at a rate of exactly 1, because parity is a stated basis', () => {
    const posted = postedBaseFigures(arm('issuedPegged'));
    expect(posted).not.toBeNull();
    expect(posted?.fxRate).toBe('1');
    // The two totals coincide here, so the numbers alone cannot tell a reader a conversion happened.
    // Going quiet on this arm would make a pegged foreign invoice look like a franc one.
    expect(posted?.totalBaseMinor).toBe(fx.issuedPegged.totalMinor);
    // And so do the two VAT figures, for the same reason and with the same consequence.
    expect(posted?.baseTaxMinor).toBe(fx.issuedPegged.taxMinor);
  });

  it('reports nothing for a foreign DRAFT, whose baseCurrency arrives without any figure', () => {
    // The arm the "all of them or none" reading of this group gets wrong. `baseCurrency` is a string
    // here while every figure is null, so a guard keyed on the currency alone would hand the UI a
    // null total and a null franc VAT to render.
    expect(fx.draftForeign.baseCurrency).toBe('CHF');
    expect(fx.draftForeign.totalBaseMinor).toBeNull();
    expect(fx.draftForeign.baseTaxMinor).toBeNull();
    expect(postedBaseFigures(arm('draftForeign'))).toBeNull();
  });

  it('refuses a half-present group rather than filling the gap in, in any of the four directions', () => {
    const withoutRate = { ...fx.issuedForeign, fxRate: null } as unknown as DocumentDto;
    const withoutTotal = { ...fx.issuedForeign, totalBaseMinor: null } as unknown as DocumentDto;
    const withoutCurrency = { ...fx.issuedForeign, baseCurrency: null } as unknown as DocumentDto;
    const withoutTax = { ...fx.issuedForeign, baseTaxMinor: null } as unknown as DocumentDto;
    // A base total with no rate beside it is an undisclosed conversion, and a rate with no total is a
    // figure the caller would have to multiply out. Both are refusals, not partial renders.
    expect(postedBaseFigures(withoutRate)).toBeNull();
    expect(postedBaseFigures(withoutTotal)).toBeNull();
    expect(postedBaseFigures(withoutCurrency)).toBeNull();
    // The fourth is the new one, and it refuses the same way. A group that arrived three-of-four is
    // an engine this client does not understand, and rendering three quarters of a disclosure is
    // worse than rendering none: the reader cannot see which quarter is missing.
    expect(postedBaseFigures(withoutTax)).toBeNull();
  });

  it('treats a base total of zero as a real figure, not as absence', () => {
    // 0 is falsy and this guard is the obvious place to lose it. A fully discounted foreign invoice
    // posts a zero base total, and it is still a stated basis.
    const zero = { ...fx.issuedForeign, totalMinor: 0, totalBaseMinor: 0 } as unknown as DocumentDto;
    expect(postedBaseFigures(zero)?.totalBaseMinor).toBe(0);
  });

  it('treats a franc VAT of ZERO as a figure too, which is the pure-export arm', () => {
    // The fourth arm, and the one `totalBaseMinor` never had to face. A pure export under MWSTG
    // Art. 23 posts debtor and revenue and writes NO output-VAT row, so the engine's subquery finds
    // nothing to sum and reports zero francs. Zero is an answer a filer can act on; null on this
    // field means nothing has posted at all, and this document posted.
    expect(fx.issuedExport.postedEntryId).not.toBeNull();
    expect(fx.issuedExport.baseTaxMinor).toBe(0);
    const posted = postedBaseFigures(arm('issuedExport'));
    expect(posted).not.toBeNull();
    expect(posted?.baseTaxMinor).toBe(0);
    // And the rest of the group is real, so the export still discloses what the books hold.
    expect(posted?.totalBaseMinor).toBe(fx.issuedExport.totalBaseMinor);
  });

  it('hands back the LEDGER franc VAT, which on a two-rate document is not the rate multiplied out', () => {
    // The witness, pinned engine-side in `test/sales/studio-base-vat-fixture.test.mjs` against the
    // posted rows. `applyFx` rounds once on the side total and allocates by largest remainder, so on
    // THIS document the books hold CHF 19.91 and the shortcut produces CHF 19.92. A single-rate body
    // would agree by luck and prove nothing, which is exactly how this class of defect hides.
    const posted = postedBaseFigures(arm('issuedTwoRate'));
    const naive = roundHalfAwayFromZero(fx.issuedTwoRate.taxMinor * Number(fx.issuedTwoRate.fxRate));
    expect(posted?.baseTaxMinor).toBe(fx.issuedTwoRate.baseTaxMinor);
    expect(posted?.baseTaxMinor).not.toBe(naive);
    expect(Math.abs((posted?.baseTaxMinor ?? 0) - naive)).toBe(1);
  });
});
