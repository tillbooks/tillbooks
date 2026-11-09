/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1) on a bank line. The agent's Vorschlag on the line carries
 * the frozen figures when its verb pins a record, says when the record changed since the proposal, and a
 * `vorschlag_stale` refusal is explained in words, with a reload, instead of the fallback. D167: the strip
 * holds no second Buchen and no "Freigeben": the row's Buchen approves; "Ablehnen" stays here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider, useT } from '../../i18n';
import type { Err } from '../../lib/client';
import { VorschlagOnLine } from './VorschlagOnLine';
import { explainRefusal } from './errors';
import { EMPTY_LOOKUPS } from './lookups';
import { parseVorschlaege, type BankInboxLine, type LineVorschlag } from './model';

/** A synthetic open line; the ignore sentence reads only the Vorschlag's own reason. */
const line = { bankTxnId: 'txn_1', state: 'open' } as unknown as BankInboxLine;

const base: LineVorschlag = {
  actionId: 'act_1',
  actor: 'agent',
  actionTool: 'ignore_bank_line',
  dialCapability: 'post',
  bankTxnId: 'txn_1',
  payload: { bankTxnId: 'txn_1', reason: 'other' },
  createdAt: '2026-10-11T09:00:00.000Z',
};

function strip(vorschlag: LineVorschlag) {
  return render(
    <I18nProvider>
      <VorschlagOnLine line={line} vorschlag={vorschlag} lookups={EMPTY_LOOKUPS} canDecide isOwn={false} busy={false} onReject={() => undefined} />
    </I18nProvider>,
  );
}

describe('the Vorschlag on a bank line', () => {
  it('unchanged: the sentence and Ablehnen, never a second Buchen or Freigeben (D167)', () => {
    strip(base);
    expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Buchen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeEnabled();
    expect(screen.queryByText(/Seit dem Vorschlag geändert/)).toBeNull();
  });

  it('changed since the proposal: no Freigeben, the sentence says why, Ablehnen stays', () => {
    strip({ ...base, changedSinceProposal: true });
    expect(screen.getByText(/Seit dem Vorschlag geändert/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeEnabled();
  });

  it('frozen figures ride on one line under the sentence', () => {
    const { container } = strip({
      ...base,
      figures: { number: 'R-2026-0007', numberPending: false, counterparty: 'Muster AG', recipient: null, amountMinor: 54000, amountBasis: 'amount', currency: 'CHF', taxMinor: null, grossMinor: null, lineCount: null },
    });
    const figures = container.querySelector('[data-figures]')?.textContent ?? '';
    expect(figures).toContain('R-2026-0007');
    expect(figures).toContain('Muster AG');
    expect(figures).toContain("Betrag CHF 540.00");
  });

  it('parseVorschlaege keeps the pin fields the engine sends', () => {
    const [v] = parseVorschlaege({
      actions: [
        {
          actionId: 'act_1',
          actor: 'agent',
          actionTool: 'ignore_bank_line',
          status: 'pending',
          payload: { bankTxnId: 'txn_1', reason: 'other' },
          createdAt: '2026-10-11T09:00:00.000Z',
          figures: { amountMinor: 54000, amountBasis: 'amount', currency: 'CHF' },
          changedSinceProposal: true,
        },
      ],
    });
    expect(v?.changedSinceProposal).toBe(true);
    expect(v?.figures?.amountMinor).toBe(54000);
  });
});

function Explain({ err }: { err: Err }) {
  const t = useT();
  const r = explainRefusal(t, err, { currency: 'CHF', lineState: 'open' } as Parameters<typeof explainRefusal>[2]);
  return (
    <div>
      <p data-testid="title">{r.title}</p>
      <p data-testid="body">{r.body}</p>
      <p data-testid="unmapped">{String(r.unmapped)}</p>
      <p data-testid="action">{r.action?.kind ?? ''}</p>
    </div>
  );
}

describe('the vorschlag_stale refusal on the bank inbox', () => {
  it('is explained in words with a reload, never the unmapped fallback', () => {
    render(
      <I18nProvider>
        <Explain err={{ ok: false, error: 'vorschlag_stale', actionId: 'act_1', actionTool: 'book_bank_line' } as Err} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('unmapped').textContent).toBe('false');
    expect(screen.getByTestId('title').textContent).toBe('Nicht ausgeführt: Der Vorschlag ist veraltet.');
    expect(screen.getByTestId('body').textContent).toContain('Bitte den Agenten, ihn neu vorzuschlagen.');
    expect(screen.getByTestId('action').textContent).toBe('reload');
  });
});
