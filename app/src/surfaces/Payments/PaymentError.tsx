/**
 * One rejection, rendered with ITS OWN copy, its own parameters, and its own way out.
 *
 * This exists because of a logged defect (A10-G13): `posting_delegate_unregistered` rendered as
 * "Der Beleg konnte nicht aktualisiert werden.", which collapsed several distinct causes into one
 * sentence that told the user nothing and offered nowhere to go. Design §7 gives every A14 code its
 * own de-CH and en copy plus a recovery link, and this component is the single place that mapping
 * is applied, so a new error state cannot quietly pick up the generic fallback.
 *
 * The recovery link is the part that stops a refusal being a dead end. `needs_fx_rate` in particular
 * is not a failure to apologise for: it is a rate the user has not recorded yet, and P10 is explicit
 * that a foreign payment with no admissible rate is refused rather than converted at a guess. So it
 * renders as a recoverable state with the pair, the date, and a link to record the rate.
 */
import { Link } from 'react-router-dom';

import type { Err } from '../../lib/client';
import { useT, formatMoney, formatDate, type TParams } from '../../i18n';
import { currencyPair } from './amount';

/** Where each recoverable code sends the user. A code absent here simply renders no link. */
const RECOVERY: Record<string, string> = {
  needs_bank_account: '/setup',
  needs_account: '/accounts',
  period_locked: '/periods',
  needs_fx_rate: '/setup',
  currency_mismatch: '/journal',
};

/** The codes whose copy this surface owns. Anything else falls to the honest generic line. */
const KNOWN = new Set([
  'allocation_mismatch',
  'allocation_target_side_mismatch',
  'allocation_counterparty_mismatch',
  'allocation_direction_mismatch',
  'allocation_exceeds_open',
  'skonto_exceeds_open',
  'needs_counterparty',
  'needs_bank_account',
  'needs_account',
  'period_locked',
  'document_already_settled',
  'already_reversed',
  'needs_fx_rate',
  'permission_denied',
  'reference_check_digit',
  'reference_unknown',
  'currency_mismatch',
  'intent_required',
]);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function money(value: unknown, currency: unknown): string {
  return typeof value === 'number' ? formatMoney(Math.abs(value), str(currency) || 'CHF') : '';
}

/**
 * Build the interpolation parameters for one code, out of the fields the ENGINE actually sends.
 *
 * Every name read here is a field on a real rejection, checked against the engine's own `err(...)`
 * calls. A parameter the engine does not send renders as its literal `{token}`, which the i18n layer
 * leaves visible on purpose: a visibly missing value is a bug report, a silently blank one is not.
 */
function paramsFor(error: Err, currency: string): TParams {
  const code = error.error;
  if (code === 'needs_fx_rate') {
    return {
      pair: currencyPair(error.currency, error.baseCurrency),
      date: formatDate(str(error.date)),
    };
  }
  if (code === 'period_locked') {
    return { period: str(error.period) || str(error.periodLabel) || str(error.date) };
  }
  if (code === 'document_already_settled') {
    return { number: str(error.number) };
  }
  if (code === 'allocation_mismatch') {
    return { amount: money(error.differenceMinor, currency) };
  }
  if (code === 'allocation_exceeds_open') {
    return {
      number: str(error.number),
      open: money(error.openMinor, currency),
      amount: money(error.amountMinor ?? error.settlementMinor, currency),
    };
  }
  if (code === 'skonto_exceeds_open') {
    return {
      number: str(error.number),
      open: money(error.openMinor, currency),
      skonto: money(error.skontoMinor, currency),
    };
  }
  if (code === 'currency_mismatch') {
    return { payCur: str(error.paymentCurrency), docCur: str(error.documentCurrency) };
  }
  return {};
}

/**
 * The ONE sentence a code renders as, parameters and all.
 *
 * There used to be two paths. The panel called `t(key, paramsFor(...))`; the reason beside the
 * disabled confirm assembled the same key and passed NO parameters at all, so it printed
 * "Periode {period} ist gesperrt." verbatim while the panel two elements above said "Periode 2026-07
 * ist gesperrt." for the same rejection. Every parameterised code was affected, and the i18n layer
 * leaves an unfilled `{token}` visible on purpose, which is what made it a visible defect rather
 * than a silent blank.
 *
 * A second interpolation path is the bug. This is the only one, and both callers use it.
 */
export function paymentErrorMessage(
  t: (key: string, params?: TParams) => string,
  error: Err,
  currency: string,
): string {
  const code = error.error;
  return KNOWN.has(code) ? t(`payment.error.${code}`, paramsFor(error, currency)) : t('payment.error.unexpected');
}

/**
 * A preview BLOCKER, shaped as the `Err` the message path takes.
 *
 * The blocker arrives under `error` on a successful preview and spells its code `code`, while a
 * rejection spells it `error`. One conversion, in one place, so the blocker's own fields (`period`,
 * `number`, `differenceMinor`, ...) reach `paramsFor` instead of being dropped on the floor.
 */
export function blockerAsErr(blocker: { code: string; [key: string]: unknown }): Err {
  return { ok: false, ...blocker, error: String(blocker.code) } as Err;
}

export interface PaymentErrorProps {
  error: Err;
  /** The currency the figures in this rejection are denominated in. Never assumed to be CHF. */
  currency?: string;
  /** An in-place recovery the caller owns, e.g. reloading the candidate list after a stale row. */
  onRetry?: () => void;
  retryLabel?: string;
}

export function PaymentError({ error, currency = 'CHF', onRetry, retryLabel }: PaymentErrorProps) {
  const t = useT();
  const code = error.error;
  const message = paymentErrorMessage(t, error, currency);
  const to = RECOVERY[code];
  const ctaKey = `payment.errorCta.${code}`;
  const cta = to === undefined ? null : t(ctaKey);
  const explain = code === 'needs_fx_rate' ? t('payment.errorExplain.needs_fx_rate') : null;

  return (
    <div className="pay-error" role="alert" data-code={code}>
      <p className="pay-error-message">{message}</p>
      {explain !== null && <p className="pay-error-explain">{explain}</p>}
      <div className="pay-error-actions">
        {to !== undefined && cta !== null && (
          <Link className="btn btn--secondary" to={to}>
            {cta}
          </Link>
        )}
        {onRetry !== undefined && (
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            {retryLabel ?? t('payment.retry')}
          </button>
        )}
      </div>
    </div>
  );
}
