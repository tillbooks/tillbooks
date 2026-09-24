/**
 * S2's currency control (A11 §6, M11-M13): pick the currency, and see what it costs you.
 *
 * The engine has supported foreign-currency invoices since the §H-FX foundation: `create_document`
 * takes a currency, `issue_invoice` resolves an admissible rate, posts the transaction and the base
 * amounts, and stamps the rate on every `journal_line`. The Studio offered a bare text box, so the
 * capability existed and no human could reach it. This is the control that reaches it.
 *
 * Two consequences follow a currency choice and they are DIFFERENT things, said differently:
 *
 *  - **The payment part** (M13). The Swiss QR-bill carries CHF and EUR only, and from 14.11.2026 a
 *    QR-IBAN carries CHF only. Both are surfaced AT the control, at the moment of choosing, never as
 *    a refusal at issue. Neither blocks the invoice: it issues, posts and renders regardless. What it
 *    loses is the payment part.
 *  - **The rate** (M11/M12). A non-base invoice posts in the base currency at the rate that governs
 *    the invoice date (MWSTV Art. 45 Abs. 1). The panel asks the engine which rate that is, through
 *    `get_exchange_rate`, the read twin of the resolution `issue_invoice` runs. With no admissible
 *    rate, issuing is blocked and the reason names the pair, the date and the way out (M12).
 *
 * What this component deliberately does NOT show is a converted total. `get_exchange_rate` answers
 * with a rate, not with money, and no read path on a document carries a base-currency total, so any
 * CHF figure here would have to be multiplied out in JavaScript. The client never does money. The
 * converted amounts exist the moment the invoice is posted, on the entry, which is one click away.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useTStrict, formatDate } from '../../i18n';
import { Select } from '../../components/Select';
import {
  currencyOptions,
  fxMethodKey,
  fxSourceKey,
  qrConsequence,
  readFxRate,
  withFxMethodContext,
  type ExchangeRateRowDto,
  type FxState,
} from './currency';

/** The select value that reveals the free-text ISO field. Never a currency code itself. */
const OTHER = '__other__';

export interface CurrencyPickerProps {
  /** The document's currency code (ISO 4217). */
  value: string;
  onChange: (currency: string) => void;
  /** The workspace's ledger base currency, from `get_company_profile`. */
  baseCurrency: string;
  /** The workspace's creditor IBAN, or null when none is configured. Decides the QR consequence. */
  iban: string | null;
  /** The invoice date: the date the rate is asked for, and the date the QR-bill is judged by. */
  issueDate: string;
  /**
   * Whether issuing this document type POSTS (invoice, credit note). A quote in EUR needs no rate to
   * be issued, because issuing one moves no money, so the panel must not tell its operator they are
   * blocked. The rate still matters for the invoice the quote becomes, and the copy says which.
   */
  posts: boolean;
  /**
   * Whether this document can carry a payment part at all. Only an invoice can: `buildQrBill`
   * refuses every other type with `not_an_invoice`. Without this the control would promise a
   * QR-reference on a quote, which is a payment part that will never exist.
   */
  isInvoice: boolean;
  /** Permission-denied: the currency renders as read-only text, with no edit affordance. */
  readOnly?: boolean;
  /**
   * The resolved FX state, reported upward so the editor can pre-disable Ausstellen with an inline
   * reason (D15/C3) instead of letting the operator discover `needs_fx_rate` at the posting step.
   */
  onFxStateChange?: (state: FxState) => void;
}

export function CurrencyPicker({
  value,
  onChange,
  baseCurrency,
  iban,
  issueDate,
  posts,
  isInvoice,
  readOnly = false,
  onFxStateChange,
}: CurrencyPickerProps) {
  const t = useT();
  const tStrict = useTStrict();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [rates, setRates] = useState<ExchangeRateRowDto[]>([]);
  const [ratesLoaded, setRatesLoaded] = useState(false);
  const [fx, setFx] = useState<FxState>({ kind: 'loading' });
  const [custom, setCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // The recorded pairs, read once: they are what turns the picker from "type a code and hope" into a
  // list of the currencies this workspace can actually bill in today.
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void client.call('list_exchange_rates', { workspaceId }).then(({ body }) => {
      if (!live) return;
      if (!isErr(body)) setRates((body.rates as ExchangeRateRowDto[]) ?? []);
      setRatesLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, reloadToken]);

  // Which rate WOULD price this invoice. Re-asked whenever the currency or the date moves, because
  // both are inputs to the answer: a rate is valid FOR a date, not forever.
  useEffect(() => {
    let live = true;
    if (value === '' || value === baseCurrency) {
      setFx({ kind: 'base', baseCurrency });
      return;
    }
    if (workspaceId === null) return;
    setFx({ kind: 'loading' });
    async function resolve() {
      const { body } = await client.call('get_exchange_rate', {
        workspaceId,
        currency: value,
        date: issueDate,
      });
      if (!live) return;
      const state = readFxRate(body, { currency: value, date: issueDate });
      if (state.kind !== 'method_not_elected') {
        setFx(state);
        return;
      }
      // The election refused the rate. `get_fx_method` is what turns "not this basis" into "and the
      // basis for this Steuerperiode is settled until <year>", which is the difference between a
      // rule quoted at someone and a rule they can act on.
      const method = await client.call('get_fx_method', { workspaceId, date: issueDate });
      if (!live) return;
      setFx(withFxMethodContext(state, method.body));
    }
    void resolve();
    return () => {
      live = false;
    };
  }, [client, workspaceId, value, baseCurrency, issueDate, reloadToken]);

  useEffect(() => {
    onFxStateChange?.(fx);
    // The callback identity is the caller's business; re-running on it would fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fx]);

  const options = currencyOptions({ baseCurrency, rates, current: value });
  const selectValue = custom || !options.includes(value) ? OTHER : value;

  const onSelect = useCallback(
    (next: string) => {
      if (next === OTHER) {
        setCustom(true);
        setCustomDraft('');
        return;
      }
      setCustom(false);
      onChange(next);
    },
    [onChange],
  );

  if (readOnly) {
    return (
      <div className="documents-field documents-currency">
        <span>{t('document.editor.currency')}</span>
        <span className="documents-currency-readonly" aria-label={t('document.editor.currency')}>
          {value}
        </span>
      </div>
    );
  }

  // Only an invoice has a payment part to lose, so only an invoice gets the consequence line. A
  // quote in USD is simply a quote in USD.
  const consequence = isInvoice ? qrConsequence({ currency: value, iban, issueDate }) : null;

  return (
    <div className="documents-currency">
      <div className="documents-field">
        <span aria-hidden="true">{t('document.editor.currency')}</span>
        <Select
          value={selectValue}
          ariaLabel={t('document.editor.currency')}
          onChange={onSelect}
          options={[
            ...options.map((code) => ({
              value: code,
              label: code === baseCurrency ? t('invoice.currency.baseOption', { currency: code }) : code,
            })),
            { value: OTHER, label: t('invoice.currency.other') },
          ]}
        />
      </div>

      {selectValue === OTHER && (
        <label className="documents-field">
          <span>{t('invoice.currency.otherCode')}</span>
          <input
            type="text"
            inputMode="text"
            maxLength={3}
            className="field documents-currency-code"
            aria-label={t('invoice.currency.otherCode')}
            aria-describedby="currency-other-hint"
            value={custom ? customDraft : value}
            onChange={(e) => {
              const next = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
              setCustom(true);
              setCustomDraft(next);
              // Only a complete ISO 4217 code becomes the document's currency: half a code would ask
              // the engine for a rate on "US" and get a refusal that means nothing to anyone.
              if (next.length === 3) onChange(next);
            }}
          />
          <span id="currency-other-hint" className="documents-currency-hint">
            {t('invoice.currency.otherHint')}
          </span>
        </label>
      )}

      {consequence !== null && <QrConsequenceLine consequence={consequence} currency={value} />}

      <FxPanel
        fx={fx}
        currency={value}
        posts={posts}
        ratesLoaded={ratesLoaded}
        hasRates={rates.length > 0}
        onRetry={() => setReloadToken((n) => n + 1)}
        t={t}
        tStrict={tStrict}
      />
    </div>
  );
}

/**
 * The consequence of THIS currency for the payment part, beside the control that caused it (M13:
 * prevent at the control). Never a refusal, never a blocker: an invoice in any currency issues.
 */
function QrConsequenceLine({
  consequence,
  currency,
}: {
  consequence: ReturnType<typeof qrConsequence>;
  currency: string;
}) {
  const t = useT();

  if (consequence.kind === 'qr') {
    return (
      <p className="documents-currency-note" role="note">
        {t(
          consequence.referenceType === 'QRR'
            ? 'invoice.currency.qr.qrr'
            : 'invoice.currency.qr.scor',
          { currency },
        )}
      </p>
    );
  }

  if (consequence.kind === 'no_iban') {
    return (
      <p className="documents-currency-note" role="note">
        {t('invoice.currency.qr.noIban')} <Link className="link-inline" to="/setup">{t('invoice.qr.toSetup')}</Link>
      </p>
    );
  }

  // A11-G9: neither of the two arms below BLOCKS anything. An invoice in USD, and an invoice a
  // QR-IBAN can no longer carry, both issue, post and render exactly as a CHF one does; what they
  // lose is the payment part, which this line says. They used to wear the same alarm bar as the
  // refusal that stops the issue outright, and an all-clear painted red is what makes the red stop
  // meaning anything.
  if (consequence.kind === 'unsupported_currency') {
    return (
      <p className="documents-currency-consequence" role="note">
        {t('invoice.currency.qr.unsupported', { currency })}
      </p>
    );
  }

  // The v2.4 cutover. Three sentences, and the third one is the honest label on the second: SIX
  // states no guidance at all for a creditor who holds only a QR-IBAN, so the remedy TILL names is
  // an inference and says so rather than borrowing the authority of a citation it does not have.
  return (
    <div className="documents-currency-consequence" role="note">
      <p>
        {t('invoice.currency.qr.chfOnly', {
          currency,
          date: formatDate(consequence.effectiveFrom),
        })}
      </p>
      <p>{t('invoice.currency.qr.chfOnlyRemedy')}</p>
      <p>{t('invoice.currency.qr.chfOnlyValidity')}</p>
    </div>
  );
}

interface FxPanelProps {
  fx: FxState;
  currency: string;
  /** See `CurrencyPickerProps.posts`: it decides whether a missing rate blocks anything today. */
  posts: boolean;
  ratesLoaded: boolean;
  hasRates: boolean;
  onRetry: () => void;
  t: ReturnType<typeof useT>;
  tStrict: ReturnType<typeof useTStrict>;
}

/**
 * The rate readout and its refusals: the five states this surface owes every panel.
 *
 * Every arm carries `data-fx="<kind>"`, which exists for the browser flows and nothing else. They
 * have to wait for this panel to reach a TERMINAL state before asserting anything about the
 * currency block, and they used to do it by waiting for one of its CLASSES. That worked only while
 * the classes were unique to this panel: the moment `documents-currency-consequence` came to be
 * shared with the QR consequence line beside it (A11-G9), the wait could be satisfied by an element
 * this panel never rendered, one that appears synchronously from a pure client function while
 * `get_exchange_rate` is still in flight. The result was a flow that measured `null` roughly one run
 * in three and reported it as a regression. A state marker says what the flows actually mean, in a
 * way no styling decision can quietly redefine.
 */
function FxPanel({ fx, currency, posts, ratesLoaded, hasRates, onRetry, t, tStrict }: FxPanelProps) {
  // The base-currency arm is not "a rate of 1". It is the absence of conversion, and §H-FX stores no
  // rate for it, so the panel states that instead of rendering a rate nobody will ever see in the
  // books.
  if (fx.kind === 'base') {
    return (
      <p className="documents-currency-note" data-fx="base" role="note">
        {t('invoice.fx.base', { currency: fx.baseCurrency })}
      </p>
    );
  }

  if (fx.kind === 'loading') {
    return (
      <p className="documents-currency-note" data-fx="loading" role="status">
        {t('invoice.fx.loading')}
      </p>
    );
  }

  if (fx.kind === 'denied') {
    return (
      <p className="documents-currency-warn" data-fx="denied" role="alert">
        {t('invoice.fx.denied')}
      </p>
    );
  }

  if (fx.kind === 'error') {
    return (
      <div className="documents-currency-warn" data-fx="error" role="alert">
        <p>{t('invoice.fx.error')}</p>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
          {t('invoice.fx.retry')}
        </button>
      </div>
    );
  }

  if (fx.kind === 'needs_rate') {
    return (
      <div
        /* A11-G9: only the POSTING case is a refusal. A quote with no rate is a consequence, and
           the copy below says so, so it must not wear the alarm bar either. */
        className={posts ? 'documents-currency-warn' : 'documents-currency-consequence'}
        data-fx="needs_rate"
        role="alert"
        aria-label={t('invoice.fx.title')}
      >
        {/* A quote in EUR issues perfectly well without a rate, because issuing one posts nothing.
            Telling its operator they are blocked would be false, and they would go hunting for a
            rate they do not need yet. The rate matters for the invoice the quote becomes.

            A11-G14: the posting case says nothing here. Ausstellen is already pre-disabled with the
            currency and the date beside it (D15/C3), so a lead sentence here would be the SAME fact
            a second time, on the same screen, three inches away. The quote case keeps its lead,
            because nothing is disabled there and no inline reason exists to carry it. */}
        {!posts && (
          <p>{t('invoice.fx.needsRateNoPosting', { currency: fx.currency, date: formatDate(fx.date) })}</p>
        )}
        <p>
          {fx.latestAsOf === null
            ? // Two different worlds, and they need two different sentences: nothing recorded at all
              // versus a rate on file that is too old (or dated after this invoice) to price this date.
              ratesLoaded && !hasRates
              ? t('invoice.fx.needsRateEmpty')
              : t('invoice.fx.needsRateNone', { currency: fx.currency })
            : t('invoice.fx.needsRateStale', {
                date: formatDate(fx.latestAsOf),
                days: fx.maxAgeDays ?? 0,
              })}
        </p>
        <Link className="link-inline" to="/setup">{t('invoice.fx.recordRate')}</Link>
      </div>
    );
  }

  if (fx.kind === 'method_not_elected') {
    return (
      <div className="documents-currency-warn" data-fx="method_not_elected" role="alert" aria-label={t('invoice.fx.title')}>
        <p>
          {t('invoice.fx.methodNotElected', {
            currency: fx.currency,
            method: tStrict(fxMethodKey(fx.method)),
            electedMethod: tStrict(fxMethodKey(fx.electedMethod)),
            taxPeriod: fx.taxPeriod,
          })}
        </p>
        {fx.locked && fx.earliestChangeablePeriod !== null && (
          <p>
            {t('invoice.fx.methodLocked', {
              taxPeriod: fx.taxPeriod,
              period: fx.earliestChangeablePeriod,
            })}
          </p>
        )}
        <p>{t('invoice.fx.methodFix', { method: tStrict(fxMethodKey(fx.electedMethod)) })}</p>
        <Link className="link-inline" to="/setup">{t('invoice.fx.recordRate')}</Link>
      </div>
    );
  }

  // Resolved. Every figure below is the engine's own string: the rate, the date it is valid for, the
  // admissible basis it declares and where it came from. Nothing is multiplied out.
  return (
    <dl className="documents-currency-rate" data-fx="resolved" aria-label={t('invoice.fx.title')}>
      <div>
        <dt>{t('invoice.fx.rate')}</dt>
        <dd className="t-num">
          {/* The rate is the engine's own canonical string, rendered verbatim: `rateMath.formatRate`
              already trimmed it to its significant places, and reformatting it here would be a
              second opinion about what the books say the rate is. */}
          {t('invoice.fx.rateLine', {
            currency: fx.currency,
            rate: fx.rate,
            baseCurrency: fx.baseCurrency,
          })}
        </dd>
      </div>
      {fx.rateAsOf !== null && (
        <div>
          <dt>{t('invoice.fx.asOf')}</dt>
          <dd>{formatDate(fx.rateAsOf)}</dd>
        </div>
      )}
      {fx.rateMethod !== null && (
        <div>
          <dt>{t('invoice.fx.basis')}</dt>
          <dd>{tStrict(fxMethodKey(fx.rateMethod))}</dd>
        </div>
      )}
      <div>
        <dt>{t('invoice.fx.origin')}</dt>
        <dd>{tStrict(fxSourceKey(fx.rateSource))}</dd>
      </div>
      <div className="documents-currency-willpost">
        <dt className="visually-hidden">{t('invoice.fx.title')}</dt>
        <dd>{t('invoice.fx.willPost', { currency, baseCurrency: fx.baseCurrency })}</dd>
      </div>
    </dl>
  );
}
