/**
 * The rate a MWST code books at on a supply date, for DISPLAY: the Studio's copy of the engine's
 * `effectiveRateBp` (`src/core/vat/applyVat.ts`) over the eras of `src/core/vat/rateEras.ts`.
 *
 * Why the Studio needs it (D167 point 5): the seed input codes `VST-M` and `VST-I` store no rate
 * (`rateBp: 0`), because the rate is the Normalsatz on the supply date. A picker that printed the
 * stored rate showed "Vorsteuer" with no figure beside "Vorsteuer 2.6 %"; this names the 8.1 % (or the
 * 7.7 % of a 2018 to 2023 supply) the engine will actually book.
 *
 * THIS IS A COPY of two era rows, kept small on purpose. The Studio is a separate Vite build with no
 * path into the engine sources, so `vatRates.test.ts` pins the rows to the values the engine file
 * carries (MWSTG Art. 25, in force 1.1.2018 and 1.1.2024). Before 2018 no era is published in the
 * engine either, and both fall back to the stored rate (the Normalsatz in force for a zero-rate input
 * code), exactly as `effectiveRateBp` does.
 */

interface Era {
  /** Inclusive, ISO date. */
  from: string;
  normalBp: number;
  reducedBp: number;
  accommodationBp: number;
}

/** Newest last, as in `VAT_RATE_ERAS`. */
export const STUDIO_RATE_ERAS: readonly Era[] = [
  { from: '2018-01-01', normalBp: 770, reducedBp: 250, accommodationBp: 370 },
  { from: '2024-01-01', normalBp: 810, reducedBp: 260, accommodationBp: 380 },
];

const NEWEST = STUDIO_RATE_ERAS[STUDIO_RATE_ERAS.length - 1] as Era;

export type RateClass = 'normal' | 'reduced' | 'accommodation';

function eraOn(date: string): Era | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let found: Era | null = null;
  for (const era of STUDIO_RATE_ERAS) if (date >= era.from) found = era;
  return found;
}

/** The class a stored rate names (any era's normal, reduced or accommodation rate), else null. */
export function rateClassOf(rateBp: number): RateClass | null {
  for (let i = STUDIO_RATE_ERAS.length - 1; i >= 0; i -= 1) {
    const era = STUDIO_RATE_ERAS[i] as Era;
    if (rateBp === era.normalBp) return 'normal';
    if (rateBp === era.reducedBp) return 'reduced';
    if (rateBp === era.accommodationBp) return 'accommodation';
  }
  return null;
}

/**
 * The rate in basis points a code of `kind` stored at `rateBp` books on `date` (today when absent):
 * a zero-rate input code is the Normalsatz of the date; a classed rate takes the date's era; anything
 * else keeps its stored rate. 0 means "no rate" (exempt, zero-rated, a code without one).
 */
export function displayRateBp(kind: string, rateBp: number, date?: string | null): number {
  const on = typeof date === 'string' && date.length >= 10 ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const era = eraOn(on);
  if (kind === 'input' && rateBp === 0) return (era ?? NEWEST).normalBp;
  const cls = rateClassOf(rateBp);
  if (era === null || cls === null) return rateBp;
  return cls === 'normal' ? era.normalBp : cls === 'reduced' ? era.reducedBp : era.accommodationBp;
}

/** The rate class a code books at (a zero-rate input code is the Normalsatz), for ordering and hints. */
export function codeRateClass(kind: string, rateBp: number): RateClass | null {
  if (kind === 'input' && rateBp === 0) return 'normal';
  return rateClassOf(rateBp);
}
