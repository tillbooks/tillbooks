/**
 * B-S3, the Eröffnungssaldo step: where all four of A19's real refusals live.
 *
 * THE OPENING BALANCE IS A SECOND DELIBERATE ACT, NEVER THE SAME SAVE AS CREATE (INV-7). A19 §5 is
 * unambiguous about the agent: "an agent registering an account from an instruction must not be able
 * to move money as a side effect of creating a master-data row", and the engine enforces it with two
 * verbs and two idempotency keys. The same argument holds for the human, so create's Save writes the
 * row and posts nothing, the drawer then advances in place to this step, and "Später" closes it
 * leaving a perfectly valid account behind. The same step is reachable later from the row overflow,
 * which is the common real sequence: register the accounts now, do the opening balances at the year
 * boundary. One component, two entry points, money always behind its own confirm.
 *
 * REFUSAL 1, `needs_account` FOR 9100 (B9), PREVENTED AT THE CONTROL AND NOW RECOVERABLE IN ONE
 * CLICK (owner decision D43). 9100 Eröffnungsbilanz is in no shipped chart, and the engine resolves
 * it by number and refuses rather than inventing an equity account. That refusal STANDS: the owner
 * declined to add 9100 to the A01 seed, and `src/core/ledger/openingBalances.ts` states why in the
 * clearest terms available, that "an account invented on the fly would be a chart entry no
 * Treuhänder agreed to". What changed is not the engine's answer, it is who performs the act.
 *
 * The editor has already read the chart WITH archived rows, so it knows before the operator types
 * anything, and the two reasons get two different recoveries: a missing 9100 offers to CREATE it,
 * and an archived one offers to REACTIVATE it. Collapsing them would send an operator to create an
 * account that already exists, where they would meet a duplicate-number rejection with no hint that
 * reactivating is the fix.
 *
 * NOTHING HAPPENS BEHIND THE OPERATOR'S BACK. The number, the name and the type are on screen BEFORE
 * the click ("9100 Eröffnungsbilanz, Typ Eigenkapital"), the two strings the sentence names are the
 * two strings sent (`OPENING_BALANCE_ACCOUNT_NAME` / `_TYPE` in `model.ts`), and the account is
 * created through A01's ordinary `create_account`, not through a private path of A19's own. A
 * deliberate, legible act by a human is a different thing from a silent substitution by a program,
 * and only the second one is what the engine's refusal exists to prevent.
 *
 * THE DEAD END THIS CLOSES WAS FOUND BY MEASUREMENT, NOT REVIEW. The A19 browser flow had to call
 * `create_account` itself before the browser could even be opened, because a fresh workspace with
 * the shipped KMU chart can register a bank account and then cannot post its opening balance at all,
 * from any surface, with no way forward that the surface names.
 *
 * REFUSAL 2, `period_locked` (B10). It rides out of `postEntry` unchanged. The step STAYS OPEN with
 * the date intact, names the period, and offers both recoveries: open the period, or change the date.
 * A dialog that vanishes on rejection makes the operator rebuild a decision they already made.
 *
 * REFUSAL 3, `needs_fx_rate` (B11), ANSWERED IN PLACE. The rate field renders whenever the account's
 * currency is not the workspace base currency, and it is PREFILLED from `get_exchange_rate` for the
 * entered date, because an empty required field the product could have filled is a decision exported
 * to the user. `needs_fx_rate` therefore fires only when no rate is admissible at all; then the field
 * is empty, carries the rejection's own words, and the operator types one. Having typed one they are
 * offered "Kurs merken", which records it, because an in-place field without that solves this posting
 * and no other. There is no Studio FX surface to link to, which is finding F5.
 *
 * REFUSAL 4 IS NOT A19'S AT ALL (B20). A04 is built, and its `account_already_has_balance` names an
 * A19 bank opening balance as the usual cause, so an operator who posts here can be refused later on
 * a different surface for something they did on this one. The treatment is one sentence before the
 * click, because the surprising part always goes before the act. No control, no banner, no second
 * confirm.
 *
 * THE BASE-CURRENCY READOUT, WHICH IS NOW HERE (A19 §6, US-A19.4, owner decision D43/B2). An earlier
 * version of this file recorded the readout's ABSENCE and the reason: A19 had no preview verb, A14
 * shipped `preview_payment` precisely so the GUI never does money arithmetic, and multiplying the
 * amount by the rate in the browser would round where no test is watching. The proposal was to show
 * the posted base amount afterwards, on the row and the linked journal entry.
 *
 * The owner declined that, and the reason the design itself had recorded is why: the click it defers
 * verification past is **Buchen**, which posts an immutable journal entry whose only correction is a
 * reversing entry. So the verb was bought rather than the readout cut. `preview_bank_opening_balance`
 * runs the posting's own arithmetic and writes nothing, and the figure below is its answer, echoed
 * and never computed. It is shown for a franc account too, not only a foreign one: for a franc
 * account it confirms the SIGN (an overdraft posts the other way round) and the contra account,
 * which are the two things an operator can still get wrong when no rate is involved.
 *
 * THE PREVIEW INFORMS; THE POSTING DECIDES. A refusal the preview reports is shown before the click,
 * which is the whole point, but it does NOT disable Buchen. The two share their code so they cannot
 * disagree, and precisely because that is an argument rather than a proof, the failure mode of being
 * wrong should be a stale sentence and never an operator locked out of a correct posting. The one
 * control that IS disabled is the one gated on 9100, which is a fact read from the chart and not
 * from the preview.
 *
 * EVERY ANSWER ON THIS STEP BELONGS TO A QUESTION, AND DIES WITH IT. This is the law the step got
 * wrong three times running, twice caught by self-review and once by an independent critic, always
 * in a different place because it was being treated as three bugs rather than one:
 *
 *   - the base figure, which described an amount already edited away;
 *   - the POSTING's refusal, which outlived the attempt that produced it and, because the preview's
 *     refusal is shown only while there is no posting refusal, masked every preview refusal for the
 *     rest of the step: on a step whose entire purpose is verifying before an irreversible write;
 *   - the rate's PROVENANCE, which kept crediting a date and a source for a number the operator had
 *     since typed themselves, sitting directly under a figure priced at their own rate.
 *   - the IDEMPOTENCY KEY, which is the fourth instance and the only one of the family that can move
 *     money. Minted once at mount, it named one posting attempt for ever, and the engine's
 *     `rememberIdempotent` fingerprints no input, so a CHF 250.00 click under the key a CHF 100.00
 *     posting had already recorded was answered `ok` with the CHF 100.00 entry and the step closed
 *     reporting success. Found by a second independent critic, on the surface, on ledger ROWS.
 *
 * So the rule is stated once, here, rather than re-derived at each call site: `preview`,
 * `previewError` and `error` are answers to one question (this amount, this date, this rate), they
 * are cleared TOGETHER by the one effect that knows the question changed, and any state added later
 * that describes an input must join them or explain in writing why it does not. There are exactly
 * two written explanations, and both are in the file:
 *
 *   - `rateSource` describes the FILE rather than the field, so instead of being cleared it carries
 *     the rate it resolved and the hint compares;
 *   - the idempotency key cannot be CLEARED (a null key is not a key), so it is DERIVED from the
 *     question instead, which is the same law reached the only way this particular state can reach
 *     it. A changed question mints a new key; an unchanged one re-clicked keeps the old, which is the
 *     property the ref was minted for and which is pinned by its own test.
 *
 * The law was written down after the third instance and the fourth was found anyway, so the honest
 * reading is that stating it is necessary and is not sufficient: every state added here has to be
 * walked against it by hand.
 *
 * A ZERO OPENING BALANCE POSTS NOTHING (B12). `amountMinor: 0` records the intent and writes no
 * entry, and the row then reads "CHF 0.00, keine Buchung". Rendering it as an ordinary posted balance
 * would imply a journal entry that does not exist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import {
  OPENING_BALANCE_ACCOUNT_NAME,
  OPENING_BALANCE_ACCOUNT_NUMBER,
  OPENING_BALANCE_ACCOUNT_TYPE,
  parseAmountMinor,
  parseOpeningPreview,
  type BankAccount,
  type OpeningAccountState,
  type OpeningPreview,
} from './model';

export interface OpeningBalanceStepProps {
  account: BankAccount;
  /** The workspace base currency, which decides whether the rate field is relevant at all. */
  baseCurrency: string;
  /** 9100's state in the chart, read WITH archived rows so the two absences stay distinguishable. */
  openingAccount: OpeningAccountState;
  /**
   * The chart READ failed, which is a third state and not a flavour of "9100 is missing".
   *
   * Without it, a failed read left `chart` null and `probing` true for ever: Buchen disabled, the
   * explanation gated behind `!probing`, and nothing on screen saying what happened. A silent
   * permanent dead end, met on the first flaky read, in front of the one step here that posts money.
   * Collapsing it into `missing` would be worse than the silence: it would offer to CREATE an account
   * that may well exist, and the operator would meet `duplicate_number` with no hint why.
   */
  chartFailed: boolean;
  /**
   * 9100's row id when the chart holds one at all, which is what the reactivation recovery needs:
   * `unarchive_account` addresses an account by id and never by number. Null when it is missing.
   */
  openingAccountId: string | null;
  /** Whether the chart probe is still in flight. The amount field stays usable throughout. */
  probing: boolean;
  /** Re-read the chart after 9100 is created or reactivated, so the block clears on its own. */
  onChartChanged: () => void;
  onPosted: () => void;
  onLater: () => void;
}

export function OpeningBalanceStep({
  account,
  baseCurrency,
  openingAccount,
  openingAccountId,
  chartFailed,
  probing,
  onChartChanged,
  onPosted,
  onLater,
}: OpeningBalanceStepProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(account.createdAt.slice(0, 10));
  const [rate, setRate] = useState('');
  /**
   * What `get_exchange_rate` answered, INCLUDING the rate itself, which is what makes the hint below
   * able to tell whether it is still describing the value in the field. Provenance recorded without
   * the value it belongs to is provenance that cannot notice it has been superseded.
   */
  const [rateSource, setRateSource] = useState<{ asOf: string; source: string; rate: string } | null>(
    null,
  );
  const [rememberRate, setRememberRate] = useState(false);
  const [posting, setPosting] = useState(false);
  /**
   * The refusal the LAST Buchen produced, and nothing wider than that.
   *
   * It is an answer to one specific question (this amount, this date, this rate), so it is true only
   * for as long as that question is the one on screen. The instant any part of the question changes
   * it stops describing anything the operator can still act on, and it is cleared by the same effect
   * that drops the stale figure, from the same trigger, because it is the same fact going stale.
   */
  const [error, setError] = useState<Err | null>(null);
  /**
   * Set when the balance POSTED but "Kurs merken" was refused. The two calls are independent, so the
   * memo never blocks the money; but the step then has to stay open long enough to say so, because
   * this component is the only thing on screen that knows the checkbox was ticked.
   */
  const [rateNotStored, setRateNotStored] = useState<Err | null>(null);
  /** The engine's answer to "what would this post", or null when there is nothing to preview yet. */
  const [preview, setPreview] = useState<OpeningPreview | null>(null);
  /** The preview's own refusal, shown before the click. It never disables Buchen: see the header. */
  const [previewError, setPreviewError] = useState<Err | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const foreign = account.currency !== baseCurrency && baseCurrency !== '';

  // The rate field is PREFILLED rather than blank: the verb is sitting right there in fx-actions.
  useEffect(() => {
    if (!foreign || workspaceId === null) return;
    let cancelled = false;
    const run = async () => {
      const response = await client.call('get_exchange_rate', {
        workspaceId,
        currency: account.currency,
        date,
      });
      if (cancelled) return;
      if (isErr(response.body)) {
        // No admissible rate: the field stays empty and the operator types one. Not an error yet.
        setRate('');
        setRateSource(null);
        return;
      }
      const resolved = response.body.rate;
      const asOf = response.body.rateAsOf;
      const source = response.body.rateSource;
      if (typeof resolved !== 'string') return;
      setRate(resolved);
      setRateSource(
        typeof asOf === 'string' && typeof source === 'string'
          ? { asOf, source, rate: resolved }
          : null,
      );
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, foreign, account.currency, date]);

  const amountMinor = parseAmountMinor(amount);
  // A chart that could not be read blocks just as hard as a missing 9100, and for a better reason:
  // the surface does not KNOW whether 9100 is there. It simply says so instead of guessing.
  const blocked = chartFailed || openingAccount !== 'present';
  /** The field holds a rate that is the operator's own, not the one `get_exchange_rate` resolved. */
  const typedRate = rate.trim() !== '' && (rateSource === null || rate.trim() !== rateSource.rate);

  /**
   * THE IDEMPOTENCY KEY IS AN ANSWER TO THE QUESTION TOO, so it dies with it (see the header).
   *
   * It used to be minted once in a ref and never reconsidered, on a comment that justified it against
   * a retry of the SAME question while saying nothing about a retry of a CHANGED one. That second
   * case is the one this step creates on purpose: a refused Buchen leaves every typed value intact so
   * the operator can edit and click again. `SqliteStore.rememberIdempotent` keys on
   * `(workspace, verb, key)` and fingerprints no input, so a CHF 250.00 request under the key a
   * CHF 100.00 posting already recorded is answered `ok` with the CHF 100.00 entry: the step closes
   * reporting a success, and the ledger holds a number nobody chose, in an entry whose only
   * correction is a reversing entry.
   *
   * So the key is derived from the question rather than from the mount. The question is built out of
   * exactly the fields the posting sends, so the key changes when, and only when, the request would
   * be a different request. The property the ref was minted for is unchanged and is pinned by its own
   * test: an unchanged question re-clicked after a lost response is still one posting.
   *
   * It is a ref rather than a `useMemo` deliberately: `useMemo` is a performance hint React is free
   * to discard, and a discarded cache here would mint a fresh key for an unchanged question, which is
   * the double-post the ref exists to prevent. Re-minting during render is safe because it is
   * decided purely by the question: a repeated or discarded render computes the same answer.
   */
  const idempotencyQuestion = JSON.stringify([
    amountMinor,
    date,
    foreign && rate.trim() !== '' ? rate.trim() : null,
  ]);
  const idempotency = useRef<{ question: string; key: string }>({
    question: idempotencyQuestion,
    key: crypto.randomUUID(),
  });
  if (idempotency.current.question !== idempotencyQuestion) {
    idempotency.current = { question: idempotencyQuestion, key: crypto.randomUUID() };
  }

  /**
   * The base-currency readout: the engine's figure, asked for on every change that could move it.
   *
   * It is deliberately NOT debounced, matching the rate effect above and the rest of this Studio. The
   * verb is a pure read against a local SQLite file, and the `cancelled` flag means an answer to a
   * superseded question is discarded rather than rendered, which is the property that actually
   * matters: what must never happen is a stale figure sitting under Buchen.
   *
   * It does not run while 9100 is missing or archived, because the answer there is `needs_account`,
   * which the block above the button already states in the operator's own terms with its recovery
   * attached. Asking anyway would put the same fact on screen twice in two different voices.
   */
  useEffect(() => {
    if (workspaceId === null || amountMinor === null || blocked || probing) {
      setPreview(null);
      setPreviewError(null);
      setError(null);
      setPreviewing(false);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    // EVERYTHING THE OLD QUESTION PRODUCED IS DROPPED TOGETHER, the moment the question changes: the
    // figure, the preview's refusal, and the POSTING's refusal. Leaving any of the three on screen
    // would put an answer under Buchen that describes an amount the operator has already edited
    // away, which is the exact failure this readout exists to prevent. It costs a flicker to "wird
    // berechnet" while typing, and that is the honest thing for it to say.
    //
    // The posting's refusal belongs here rather than at its own call site for the reason it was
    // missed the first time: `error` is not "something that went wrong once", it is the answer to a
    // question, and this effect is the one place that knows the question changed. Clearing it inside
    // `post()` alone left it outliving its own question, which both left a superseded sentence on
    // screen AND, because the preview's refusal is shown only while there is no posting refusal,
    // silently masked every preview refusal for the rest of the step.
    setPreview(null);
    setPreviewError(null);
    setError(null);
    const run = async () => {
      const response = await client.call('preview_bank_opening_balance', {
        workspaceId,
        bankAccountId: account.id,
        amountMinor,
        date,
        ...(foreign && rate.trim() !== '' ? { fxRate: rate.trim() } : {}),
      });
      if (cancelled) return;
      setPreviewing(false);
      if (isErr(response.body)) {
        setPreview(null);
        setPreviewError(response.body);
        return;
      }
      // Parsed as strictly as every other payload on this surface: a shape that changed renders
      // nothing rather than `undefined` where a figure belongs.
      setPreview(parseOpeningPreview(response.body));
      setPreviewError(null);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, account.id, amountMinor, date, rate, foreign, blocked, probing]);

  const post = useCallback(async () => {
    if (workspaceId === null || amountMinor === null) return;
    setPosting(true);
    setError(null);

    // "Kurs merken", offered only after the operator has typed one. Its own key, its own verb, and
    // its own answer: `recordExchangeRate` asserts `post` and REFUSES a differing rate under the same
    // date and source (`rate_conflict`), so the response is read rather than discarded. It is not
    // awaited into the posting's fate: the memo is a convenience and the balance is the act.
    let rateRefusal: Err | null = null;
    if (rememberRate && foreign && rate.trim() !== '') {
      const rateResponse = await client.call('record_exchange_rate', {
        workspaceId,
        baseCurrency: account.currency,
        rate: rate.trim(),
        asOf: date,
        source: 'manual',
        method: 'daily',
        idempotencyKey: `${idempotency.current.key}-rate`,
      });
      if (isErr(rateResponse.body)) rateRefusal = rateResponse.body;
    }

    const response = await client.call('set_bank_opening_balance', {
      workspaceId,
      bankAccountId: account.id,
      amountMinor,
      date,
      ...(foreign && rate.trim() !== '' ? { fxRate: rate.trim() } : {}),
      idempotencyKey: idempotency.current.key,
    });
    setPosting(false);
    if (isErr(response.body)) {
      // Every typed value survives: the step stays open exactly as the operator left it.
      setError(response.body);
      return;
    }
    // The balance is posted either way. When the memo was refused the step holds open to report it,
    // and its only remaining action closes and re-reads, exactly as `onPosted` always did.
    if (rateRefusal !== null) {
      setRateNotStored(rateRefusal);
      return;
    }
    onPosted();
  }, [client, workspaceId, account.id, account.currency, amountMinor, date, rate, rememberRate, foreign, onPosted]);

  return (
    <div className="bank-step">
      <ol className="bank-journey" aria-label={t('bank.step.label')}>
        <li className="bank-journey-step bank-journey-step--done">{t('bank.step.account')}</li>
        <li className="bank-journey-step bank-journey-step--on" aria-current="step">
          {t('bank.step.openingBalance')}
        </li>
      </ol>

      <div className="form-stack">
        <div className="form-row">
          <label className="field-label-row" htmlFor="bank-opening-amount">
            {t('bank.openingBalance.label')} ({account.currency})
          </label>
          <input
            id="bank-opening-amount"
            className="field bank-input"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          {amount.trim() !== '' && amountMinor === null && (
            <p className="field-error">{t('bank.error.amount')}</p>
          )}
          {amountMinor === 0 && <p className="field-hint">{t('bank.openingBalance.zeroHint')}</p>}
        </div>

        <div className="form-row">
          <label className="field-label-row" htmlFor="bank-opening-date">
            {t('bank.openingBalance.date')}
          </label>
          <input
            id="bank-opening-date"
            className="field bank-input"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>

        {foreign && (
          <div className="form-row">
            <label className="field-label-row" htmlFor="bank-opening-rate">
              {t('bank.fxRate.label', { currency: account.currency, base: baseCurrency })}
            </label>
            <input
              id="bank-opening-rate"
              className="field bank-input"
              inputMode="decimal"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
            {/*
              THREE STATES, THREE SENTENCES, AND THE HINT ALWAYS DESCRIBES WHAT IS IN THE FIELD.
              There used to be two, and the provenance one was set from `get_exchange_rate` and never
              reconsidered, so overtyping the prefilled rate left a source and a date credited for a
              number the operator had just typed themselves, directly under a figure priced at it.
              The "nothing is on file" sentence cannot stand in for it either: it would be flatly
              false whenever a rate WAS resolved, and equally false the moment the operator has typed
              one, which is the second small lie the same change closes.
            */}
            {typedRate ? (
              <p className="field-hint">{t('bank.fxRate.typed')}</p>
            ) : rateSource !== null ? (
              <p className="field-hint">
                {/* The engine answers ISO; a human reads 19.07.2026. */}
                {t('bank.fxRate.resolved', {
                  date: formatDate(rateSource.asOf),
                  source: rateSource.source,
                })}
              </p>
            ) : (
              <p className="field-hint">{t('bank.fxRate.typeIt')}</p>
            )}
            {rate.trim() !== '' && (
              <label className="bank-check" htmlFor="bank-remember-rate">
                <input
                  id="bank-remember-rate"
                  type="checkbox"
                  checked={rememberRate}
                  onChange={(event) => setRememberRate(event.target.checked)}
                />
                <span>{t('bank.fxRate.remember')}</span>
              </label>
            )}
          </div>
        )}
      </div>

      {/*
        A19 §6 / US-A19.4, the engine's own figure, before the irreversible click.

        It is absent, rather than pending, once the preview has REFUSED. The pending branch renders
        on "there is no figure", and a refusal is one of the two ways to have no figure, so a refused
        preview used to leave the region reading "wird berechnet" for ever while `aria-busy` was
        correctly absent: the visible text and the accessible state said opposite things. There is
        nothing being calculated, and the refusal below says what there is instead.
      */}
      {!blocked && amountMinor !== null && previewError === null && (
        <div className="bank-preview" role="status" {...(previewing ? { 'aria-busy': true } : {})}>
          <span className="bank-preview-label">{t('bank.openingBalance.preview.label')}</span>{' '}
          {preview !== null ? (
            <>
              <strong className="bank-preview-amount t-money">
                {formatMoney(preview.baseAmountMinor, preview.baseCurrency)}
              </strong>
              {preview.fxRate !== null && (
                <span className="bank-preview-note">
                  {' '}
                  ({t('bank.openingBalance.preview.converted', { rate: preview.fxRate })})
                </span>
              )}
              {preview.posts && (
                <span className="bank-preview-note"> {t('bank.openingBalance.preview.contra')}</span>
              )}
            </>
          ) : (
            <span className="bank-preview-note">{t('bank.openingBalance.preview.pending')}</span>
          )}
        </div>
      )}

      {/*
        The A04 collision, said BEFORE the click because the surprising part always goes before the
        act. It exists so the operator recognises the later refusal as a consequence of a choice they
        made, rather than as a product that contradicts itself.
      */}
      <p className="bank-consequence">{t('bank.openingBalance.consequence')}</p>

      {/* The chart read itself failed, so the surface says that rather than a fact about 9100 it has
          no basis for. The retry is the same callback the 9100 recoveries use: the owner of the chart
          state re-reads, and the block clears from the same read that judged it. */}
      {chartFailed && <ErrorBanner message={t('bank.error.chart')} onRetry={onChartChanged} />}

      {/* B9, prevented at the control: the reason is inline, never hover-only, and the two absences
          of 9100 get two different recoveries, one of which is now performable right here. */}
      {blocked && !probing && !chartFailed && (
        <MissingOpeningAccount
          state={openingAccount}
          accountId={openingAccountId}
          onReady={onChartChanged}
        />
      )}

      {/* The preview's refusal, when the post has not produced one of its own yet. Same sentences,
          same recoveries, arriving before the click instead of after it. */}
      {error === null && previewError !== null && <OpeningError error={previewError} />}

      {error !== null && <OpeningError error={error} />}

      {rateNotStored !== null && <RateNotStored error={rateNotStored} />}

      {rateNotStored === null ? (
        <div className="form-actions">
          <button type="button" className="btn btn--secondary" onClick={onLater}>
            {t('bank.openingBalance.later')}
          </button>
          <button
            type="button"
            className="btn btn--accent"
            data-money-commit="set_bank_opening_balance"
            disabled={amountMinor === null || blocked || probing || posting}
            onClick={() => void post()}
          >
            {t('bank.openingBalance.post')}
          </button>
        </div>
      ) : (
        /* The balance is posted, so Buchen is GONE rather than disabled: leaving it on screen would
           invite a replay of an act that already happened. One way out, and it re-reads the row. */
        <div className="form-actions">
          <button type="button" className="btn btn--primary" onClick={onPosted}>
            {t('bank.fxRate.notStored.close')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * B9 with its recovery attached: 9100 is missing or archived, and one click fixes it (D43).
 *
 * TWO ABSENCES, TWO VERBS, AND NEVER ONE COLLAPSED CONTROL. A missing 9100 is created through A01's
 * ordinary `create_account`; an archived one is restored through `unarchive_account`, which needs the
 * row's ID and not its number. Offering "anlegen" for an archived account would walk the operator
 * into `duplicate_number` with no hint that reactivating is the fix, which is the defect the two
 * sentences were split for in the first place.
 *
 * WHAT IS SHOWN BEFORE THE CLICK IS WHAT IS SENT. The detail line names the number, the name and the
 * type, and the payload is built from the same two constants the sentence is written around. The
 * engine's refusal to invent 9100 is untouched and correct: what this control changes is that a
 * human performs the act deliberately instead of a program performing it silently.
 *
 * THE FAILURES ARE NAMED, NOT SWALLOWED. `duplicate_number` means the chart moved under an open
 * drawer and the answer is a reload, not a retry. `permission_denied` is not the operator's to fix at
 * all, so it says who can. Anything else keeps the chart link, which is the recovery this block used
 * to be, so the click never leaves the operator with fewer ways out than before it existed.
 */
function MissingOpeningAccount({
  state,
  accountId,
  onReady,
}: {
  state: OpeningAccountState;
  accountId: string | null;
  onReady: () => void;
}) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<Err | null>(null);
  /** Minted once, so a transport failure cannot leave two 9100s behind on a retry. */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const archived = state === 'archived';

  const fix = useCallback(async () => {
    if (workspaceId === null) return;
    setWorking(true);
    setFailure(null);
    const response =
      archived && accountId !== null
        ? await client.call('unarchive_account', { workspaceId, accountId })
        : await client.call('create_account', {
            workspaceId,
            number: OPENING_BALANCE_ACCOUNT_NUMBER,
            name: OPENING_BALANCE_ACCOUNT_NAME,
            type: OPENING_BALANCE_ACCOUNT_TYPE,
            idempotencyKey: idempotencyKey.current,
          });
    setWorking(false);
    if (isErr(response.body)) {
      setFailure(response.body);
      return;
    }
    // The chart is re-read by the owner of the chart state, so `blocked` clears from the same read
    // that judged it. Deciding here that it worked would be this component believing itself.
    onReady();
  }, [client, workspaceId, archived, accountId, onReady]);

  const failureText =
    failure === null
      ? null
      : failure.error === 'duplicate_number'
        ? t('bank.error.needsAccount9100.duplicate')
        : failure.error === 'permission_denied'
          ? t('bank.error.needsAccount9100.denied')
          : t('bank.error.needsAccount9100.failed');

  return (
    <div className="bank-blocked" role="status">
      <p className="bank-blocked-text">
        {archived
          ? t('bank.error.needsAccount9100.archived')
          : t('bank.error.needsAccount9100.missing')}
      </p>
      {/* The number, the name and the type, on screen before the click. Nothing is invented behind
          the operator's back: this is the whole of what the button does. */}
      <p className="bank-blocked-text">
        {archived
          ? t('bank.error.needsAccount9100.archivedDetail')
          : t('bank.error.needsAccount9100.missingDetail')}
      </p>
      {failureText !== null && <p className="field-error">{failureText}</p>}
      <div className="bank-note-actions">
        <button type="button" className="btn btn--secondary btn--sm" disabled={working} onClick={() => void fix()}>
          {working
            ? archived
              ? t('bank.error.needsAccount9100.reactivating')
              : t('bank.error.needsAccount9100.working')
            : archived
              ? t('bank.error.needsAccount9100.archivedAction')
              : t('bank.error.needsAccount9100.missingAction')}
        </button>
        {/* The chart stays one click away. An operator who would rather look before acting, or who
            just met a refusal this control cannot clear, must not be left with only a dead button. */}
        <Link className="btn btn--ghost btn--sm" to="/accounts">
          {t('bank.error.needsAccount9100.toChart')}
        </Link>
      </div>
    </div>
  );
}

/**
 * F7: the balance posted, and "Kurs merken" did not.
 *
 * Three questions, in the canon's order: what happened (the balance is posted, the rate is not
 * stored), why (the engine's own reason), and what now. `rate_conflict` is the interesting one, and
 * it is not a mistake the operator can simply repeat away: a rate already recorded under this date
 * and source may already have priced a posted entry, so the recovery is a different date, never an
 * overwrite. The stored figure is ECHOED from the engine, never computed here.
 */
function RateNotStored({ error }: { error: Err }) {
  const t = useT();

  const stored = typeof error.storedRate === 'string' ? error.storedRate : null;
  const reason =
    error.error === 'rate_conflict' && stored !== null
      ? t('bank.fxRate.notStored.conflict', { stored })
      : error.error === 'permission_denied'
        ? t('bank.fxRate.notStored.denied')
        : t('errors.fallback');

  return (
    <div className="bank-blocked" role="alert">
      <p className="bank-blocked-text">{t('bank.fxRate.notStored.text')}</p>
      <p className="bank-blocked-text">{reason}</p>
    </div>
  );
}

/** Every rejection the post can carry, each with its own sentence and its own way out. */
function OpeningError({ error }: { error: Err }) {
  const t = useT();

  if (error.error === 'period_locked') {
    const period = typeof error.period === 'string' ? error.period : t('bank.error.periodLocked.unnamed');
    return (
      <div className="bank-blocked" role="alert">
        <p className="bank-blocked-text">{t('bank.error.periodLocked.text', { period })}</p>
        <Link className="btn btn--secondary btn--sm" to="/periods">
          {t('bank.error.periodLocked.action')}
        </Link>
      </div>
    );
  }

  if (error.error === 'needs_account') {
    const archived = error.reason === 'archived';
    return (
      <div className="bank-blocked" role="alert">
        <p className="bank-blocked-text">
          {archived ? t('bank.error.needsAccount9100.archived') : t('bank.error.needsAccount9100.missing')}
        </p>
        <Link className="btn btn--secondary btn--sm" to="/accounts">
          {archived
            ? t('bank.error.needsAccount9100.archivedAction')
            : t('bank.error.needsAccount9100.missingAction')}
        </Link>
      </div>
    );
  }

  if (error.error === 'needs_fx_rate') {
    const currency = typeof error.currency === 'string' ? error.currency : '';
    // `formatDate` returns its input unchanged when it is not an ISO date, so a missing or odd
    // `date` degrades to what the engine said rather than to a wrong Swiss date.
    const date = typeof error.date === 'string' ? formatDate(error.date) : '';
    return (
      <p className="field-error" role="alert">
        {t('bank.error.needsFxRate', { currency, date })}
      </p>
    );
  }

  // B13 designs this one out: the step is absent once `openingEntryId` is set, so no control on any
  // screen can produce it. The branch exists for the chart changing under an open drawer, and it says
  // what happened without quoting a figure in a currency this component would have to guess.
  if (error.error === 'opening_balance_already_set') {
    return (
      <p className="field-error" role="alert">
        {t('bank.error.openingBalanceAlreadySet')}
      </p>
    );
  }

  if (error.error === 'permission_denied') {
    return (
      <p className="field-error" role="alert">
        {t('bank.error.permissionDenied.post')}
      </p>
    );
  }

  return (
    <p className="field-error" role="alert">
      {t('errors.fallback')}
    </p>
  );
}

/** Exported for the tests, which assert the account number is never hardcoded twice. */
export const OPENING_ACCOUNT = OPENING_BALANCE_ACCOUNT_NUMBER;
