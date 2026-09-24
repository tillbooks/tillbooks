/**
 * A05, the Saldo eligibility read (`vat_saldo_eligibility`), billed to A05 by G17's design §8d.
 *
 * It answers §6a's one computable eligibility question, "wie steht mein Umsatz zur Saldo-Grenze?",
 * and deliberately nothing more: it returns the Art. 37 Abs. 1 limits in force TODAY beside the
 * measured taxable turnover of ONE calendar year, and it NEVER returns a verdict. Why no verdict
 * is computable (corrected per the corpus critic's F5, verified 2026-08-18 against the MWSTV
 * 20250101 consolidation and MWST-Info 12 Ziff. 1.3.3): the test is cumulative, the tax-due half
 * is computed at a Saldosteuersatz the ESTV has not granted yet, and the WINDOW the ESTV judges
 * differs by case while the limits stay the SAME. A newly registered person is judged on the
 * EXPECTED turnover and tax of the first twelve months (MWSTV Art. 78 Abs. 2, a forecast no ledger
 * contains); an existing filer switching in is judged on the PREVIOUS Steuerperiode (MWSTV Art. 79
 * Abs. 2), which is exactly what this read measures by defaulting `year` to the previous calendar
 * year. One measured year is therefore a faithful input to the Art. 79 case and only an analogy
 * for the Art. 78 one, so "am I eligible" has no computed answer and the copy must not imply one.
 *
 * THE THREE HONEST STATES of the measurement (design rows 3.5 / 4.3), and no fourth:
 *   - measured: the year's Ziffer 299 (steuerbarer Gesamtumsatz) from `computeVatReturn`, the
 *     audited A07 path, so this read can never disagree with the return it foreshadows.
 *   - no turnover yet: the year computed empty. Reported as `empty`, never rendered as `CHF 0.00`.
 *   - unavailable: `computeVatReturn` refused (Ist timing, a method change straddling the year,
 *     missing config). The refusal's own code is passed through, and the LIMITS still return:
 *     they are constants and a failed measurement must not take the law down with it.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err, type Result } from '../result.js';
import { computeVatReturn } from './abrechnung.js';
import { saldoEligibilityOn } from './rateEras.js';

export interface SaldoEligibilityInput {
  /** The calendar year to measure, `YYYY`. Defaults to the PREVIOUS calendar year: a full year is what the annual limits compare against. */
  year?: unknown;
}

export function saldoEligibility(ctx: WorkspaceContext, input?: SaldoEligibilityInput): Result {
  const today = ctx.clock.now().slice(0, 10);
  const rawYear = input?.year;
  let year: string;
  if (rawYear === undefined || rawYear === null) {
    year = String(Number(today.slice(0, 4)) - 1);
  } else if (typeof rawYear === 'string' && /^\d{4}$/.test(rawYear)) {
    year = rawYear;
  } else {
    return err('invalid_input', { field: 'year', expected: 'YYYY' });
  }

  const limits = saldoEligibilityOn(today);
  if (limits === null) {
    // Unreachable while the clock is sane (the table starts 2023-01-01), stated rather than assumed.
    return err('no_published_limits', { asOf: today });
  }

  const computed = computeVatReturn(ctx, { periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
  if (!computed.ok) {
    return ok({
      year,
      asOf: today,
      limits,
      measured: null,
      unavailable: {
        error: String((computed as Record<string, unknown>).error ?? 'unknown'),
        reason: (computed as Record<string, unknown>).reason ?? null,
      },
    });
  }

  const lines = (computed as unknown as { lines: { code: string; baseMinor: number }[] }).lines ?? [];
  const steuerbarerUmsatz = lines.find((l) => l.code === '299');
  const empty = (computed as unknown as { empty?: boolean }).empty === true;
  return ok({
    year,
    asOf: today,
    limits,
    measured: {
      turnoverMinor: steuerbarerUmsatz?.baseMinor ?? 0,
      /** True when the year holds no tagged posted rows at all: render the no-turnover sentence, never `CHF 0.00`. */
      empty,
    },
    unavailable: null,
  });
}
