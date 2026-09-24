/**
 * The `ch` locale pack: Switzerland as the FIRST REGISTERED PACK rather than the baked-in default
 * (G10 §2 US-G10.4).
 *
 * THE ONE PLACE UNDER `src/core/migration/` THAT MAY NAME A KMU ACCOUNT NUMBER OR AN MWST CODE.
 * The locale fence test (spec §7) holds that boundary. And even here, almost nothing is spelled by
 * hand: the chart is DERIVED from A01's shipped `KMU_CORE_SEED` and the tax codes from A05's
 * `DEFAULT_TAX_CODES` / `VAT_RATE_ERAS`, because "assert VALUES, not keys" cut the other way once
 * already: eight hand-written account names were wrong against the shipped chart while every kind
 * matched. A pack that restated the seed would drift from it; a pack that derives cannot.
 *
 * WHAT IS AUTHORED HERE, AND ITS PROVENANCE:
 *  - `headerSynonyms`: common de/fr/it column headers in Swiss accounting exports, TILL's own
 *    wording of everyday accounting vocabulary (Datum, Buchungstext, Soll, Haben, ...). No vendor
 *    export layout was read or reproduced for this list: it is generic bookkeeping German/French/
 *    Italian, the clean-room posture in CLAUDE.md.
 *  - `parseConventions`: Swiss number and date conventions (d.m.y, apostrophe grouping), public
 *    convention, not anyone's design.
 *  - `statutoryAnchors`: the statutes the chart structure and rate eras derive from, restated from
 *    the single sources they are pinned in (kmuSeed.ts, rateEras.ts).
 *
 * TAX SUGGESTIONS CARRY A CODE AND A WINDOW, NEVER A RATE THE RESOLVER COMPUTES WITH (P6): the
 * `rateBp` on a suggestion is the MATCH KEY against what the source believed, and the suggested
 * `validFrom` is the era boundary from `VAT_RATE_ERAS`, so a suggestion for the 8.1 codes begins
 * exactly where MWSTG Art. 25's current version does.
 */

import { KMU_CORE_SEED } from '../../../accounts/kmuSeed.js';
import { DEFAULT_TAX_CODES } from '../../../vat/enums.js';
import { VAT_RATE_ERAS } from '../../../vat/rateEras.js';
import type { ChartSynonym, LocalePack, TaxRateSuggestion } from '../registry.js';
import { normalizeToken } from '../registry.js';

/** Every label of every seed account, in all four shipped languages, normalized, -> its number. */
const CHART_SYNONYMS: readonly ChartSynonym[] = KMU_CORE_SEED.flatMap((a) =>
  [a.labels.de, a.labels.fr, a.labels.it, a.labels.en].map((label) => ({
    label: normalizeToken(label),
    targetNumber: a.number,
  })),
);

/**
 * The current era's start, derived from the APPEND-ONLY era table's last row rather than spelled:
 * the suggestion window for today's codes begins where the statute's current version does.
 */
const CURRENT_ERA = VAT_RATE_ERAS[VAT_RATE_ERAS.length - 1];

/**
 * Rate-keyed suggestions for the seeded OUTPUT codes. A source that says "8.1%" suggests `UST81`
 * with the era's own `validFrom`; input-side and zero-rated codes are not rate-distinguishable
 * (several share 0 bp), so they are deliberately not suggested by rate and stay a manual pick.
 */
const TAX_RATE_SUGGESTIONS: readonly TaxRateSuggestion[] =
  CURRENT_ERA === undefined
    ? []
    : DEFAULT_TAX_CODES.filter((c) => c.kind === 'output' && c.rateBp > 0).map((c) => ({
        rateBp: c.rateBp,
        targetCode: c.code,
        validFrom: CURRENT_ERA.effectiveFrom,
      }));

export const CH_LOCALE_PACK: LocalePack = {
  id: 'ch',
  label: 'Schweiz (KMU-Kontenrahmen, MWST)',
  targetChartSeed: {
    id: 'kmu-core',
    accountNumbers: KMU_CORE_SEED.map((a) => a.number),
  },
  taxCodeSet: DEFAULT_TAX_CODES.map((c) => c.code),
  parseConventions: {
    dateOrder: 'dmy',
    decimalSeparator: '.',
    groupingSeparator: "'",
    negativeShape: 'leading_minus',
  },
  statutoryAnchors: [
    'OR Art. 959a (Mindestgliederung der Bilanz)',
    'OR Art. 959b (Mindestgliederung der Erfolgsrechnung)',
    'MWSTG Art. 25 (Steuersätze, date-versioned in core/vat/rateEras.ts)',
    'OR Art. 957a Abs. 2 Ziff. 3 (Klarheit)',
  ],
  headerSynonyms: [
    { header: normalizeToken('Datum'), field: 'date' },
    { header: normalizeToken('Belegdatum'), field: 'date' },
    { header: normalizeToken('Valuta'), field: 'date' },
    { header: normalizeToken('Buchungstext'), field: 'description' },
    { header: normalizeToken('Text'), field: 'description' },
    { header: normalizeToken('Bezeichnung'), field: 'description' },
    { header: normalizeToken('Libellé'), field: 'description' },
    { header: normalizeToken('Descrizione'), field: 'description' },
    { header: normalizeToken('Betrag'), field: 'amount' },
    { header: normalizeToken('Montant'), field: 'amount' },
    { header: normalizeToken('Importo'), field: 'amount' },
    { header: normalizeToken('Soll'), field: 'debit' },
    { header: normalizeToken('Débit'), field: 'debit' },
    { header: normalizeToken('Dare'), field: 'debit' },
    { header: normalizeToken('Haben'), field: 'credit' },
    { header: normalizeToken('Crédit'), field: 'credit' },
    { header: normalizeToken('Avere'), field: 'credit' },
    { header: normalizeToken('Konto'), field: 'account' },
    { header: normalizeToken('Kontonummer'), field: 'account' },
    { header: normalizeToken('Compte'), field: 'account' },
    { header: normalizeToken('Conto'), field: 'account' },
    { header: normalizeToken('Gegenkonto'), field: 'contraAccount' },
    { header: normalizeToken('MWST-Code'), field: 'taxCode' },
    { header: normalizeToken('MWST'), field: 'taxCode' },
    { header: normalizeToken('Steuercode'), field: 'taxCode' },
    { header: normalizeToken('Code TVA'), field: 'taxCode' },
    { header: normalizeToken('Währung'), field: 'currency' },
    { header: normalizeToken('Monnaie'), field: 'currency' },
    { header: normalizeToken('Valuta-Währung'), field: 'currency' },
    { header: normalizeToken('Beleg'), field: 'reference' },
    { header: normalizeToken('Belegnummer'), field: 'reference' },
    { header: normalizeToken('Saldo'), field: 'balance' },
    { header: normalizeToken('Solde'), field: 'balance' },
  ],
  chartSynonyms: CHART_SYNONYMS,
  taxRateSuggestions: TAX_RATE_SUGGESTIONS,
};
