/**
 * A41 (D184): the Studio touch-points. The clip says "1 passender Beleg" and attaches it with one click; the
 * agent's proposal carries TILL's own evidence in the inbox's certainty words; the pick bar and the rule card
 * ask an ask-first threshold before it takes effect. SYNTHETIC DATA ONLY: invented ids, names and amounts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { DecidedRow } from './InboxRow';
import { EvidenceLines } from './VorschlagOnLine';
import { PickBar } from './PickBar';
import { RuleAutopilotSwitch, type AutobookCandidate } from './RuleAutopilot';
import { EMPTY_LOOKUPS } from './lookups';
import type { BankInboxLine, VorschlagEvidence } from './model';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
type Call = { action: string; input: Record<string, unknown> };

function wrap(transport: Transport, ui: ReactNode) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">{ui}</I18nProvider>
    </TillClientProvider>,
  );
}

const group = (fileId: string) => ({
  groupKey: fileId,
  files: [{ fileId, captureId: 'cap_1', filename: 'wolkenhaus-juli.pdf', vendorName: 'Wolkenhaus AG', invoiceDate: '2026-07-18', amountMinor: 8990, currency: 'CHF', vatAmountMinor: null }],
  amountMinor: 8990,
  currency: 'CHF',
  vendorName: 'Wolkenhaus AG',
  date: '2026-07-18',
  match: { amount: 'exact' as const, days: 2, counterparty: 'name' as const },
  vat: null,
});

const booked = (over: Partial<BankInboxLine> = {}): BankInboxLine =>
  ({
    bankTxnId: 'bt_1',
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'booked',
    bookingDate: '2026-07-20',
    valueDate: '2026-07-20',
    amountMinor: -8990,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: 'Wolkenhaus AG', iban: null },
    remittance: { text: null, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    attention: null,
    receiptCount: 0,
    needsReceipt: true,
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    belegCandidates: [group('file_1')],
    ...over,
  }) as BankInboxLine;

function decided(line: BankInboxLine, canAttach: boolean, onAttachBeleg: () => void, onOpenReceipts: () => void = () => undefined) {
  return wrap(
    async () => ok(),
    <table>
      <tbody>
        <DecidedRow
          line={line}
          selected={false}
          showCurrency={false}
          summary="Hosting"
          undoLabel="Stornieren"
          canUndo
          canAttach={canAttach}
          onUndo={() => undefined}
          onAttach={() => undefined}
          onAttachBeleg={onAttachBeleg}
          onOpenReceipts={onOpenReceipts}
          onToggle={() => undefined}
          onDropFiles={null}
        />
      </tbody>
    </table>,
  );
}

describe('A41.1: the clip offers the matching receipt', () => {
  it('one candidate: "1 passender Beleg", attached with one click', () => {
    let attached = 0;
    decided(booked(), true, () => (attached += 1));
    const clip = screen.getByRole('button', { name: 'Belege, Wolkenhaus AG, 1 passender Beleg, anhängen' });
    expect(clip).toHaveTextContent('+1');
    fireEvent.click(clip);
    expect(attached).toBe(1);
  });

  it('several candidates open the Belege instead; no right to attach shows the plain "Ohne Beleg" clip', () => {
    let opened = 0;
    let attached = 0;
    const { unmount } = decided(booked({ belegCandidates: [group('file_1'), group('file_2')] }), true, () => (attached += 1), () => (opened += 1));
    fireEvent.click(screen.getByRole('button', { name: 'Belege, Wolkenhaus AG, 2 passende Belege' }));
    expect(opened).toBe(1);
    expect(attached).toBe(0);
    unmount();
    decided(booked(), false, () => (attached += 1));
    expect(screen.queryByRole('button', { name: /passender Beleg/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Belege, Wolkenhaus AG, ohne Beleg' })).toBeTruthy();
  });

  it('an empty candidate list (a seat without the filing right gets one) renders the plain clip', () => {
    decided(booked({ belegCandidates: [] }), true, () => undefined);
    expect(screen.queryByRole('button', { name: /passende/ })).toBeNull();
  });
});

const evidence = (over: Partial<VorschlagEvidence> = {}): VorschlagEvidence => ({
  certainty: 'sure',
  agrees: true,
  reasons: ['agrees'],
  engine: { certainty: 'sure', reasonCode: 'standard', reasonParams: {}, target: null },
  belege: [],
  vat: null,
  ...over,
});

describe('A41.2/A41.4: TILL\'s own word on the agent\'s proposal', () => {
  it('agreement carries the engine\'s certainty in the inbox\'s words', () => {
    wrap(async () => ok(), <EvidenceLines line={booked({ state: 'open' })} evidence={evidence()} lookups={EMPTY_LOOKUPS} />);
    expect(screen.getByText('TILL: Sicher')).toBeTruthy();
    expect(screen.getByText(/TILL schlägt dieselbe Buchung vor\./)).toBeTruthy();
  });

  it('a receipt amount difference and the two VAT figures are said in plain words', () => {
    wrap(
      async () => ok(),
      <EvidenceLines
        line={booked({ state: 'open' })}
        evidence={evidence({
          certainty: 'check',
          reasons: ['agrees', 'beleg_amount_differs', 'vat_rounding'],
          belege: [{ fileId: 'file_9', captureId: 'cap_9', amountMinor: 9900, currency: 'CHF', amountAgrees: false }],
          vat: { belegMinor: 998, computedMinor: 1000, deltaMinor: -2, toleranceMinor: 5, withinTolerance: true },
        })}
        lookups={EMPTY_LOOKUPS}
      />,
    );
    expect(screen.getByText('TILL: Bitte prüfen')).toBeTruthy();
    expect(screen.getByText(/Ein Beleg passt nicht zum Betrag der Zeile: CHF\s?99\.00 auf dem Beleg\./)).toBeTruthy();
    expect(screen.getByText(/MWST laut Beleg CHF\s?9\.98, gerechnet CHF\s?10\.00\./)).toBeTruthy();
  });

  it('receipts the seat may not read: no figure, only that they are hidden', () => {
    wrap(async () => ok(), <EvidenceLines line={booked({ state: 'open' })} evidence={evidence({ certainty: 'check', reasons: ['agrees', 'belege_not_readable'] })} lookups={EMPTY_LOOKUPS} />);
    expect(screen.getByText('Die Belege siehst du nicht; prüfe, bevor du freigibst.')).toBeTruthy();
  });
});

describe('A41.7: an ask-first threshold is asked before it takes effect', () => {
  it('the pick bar asks from how many equal bookings learned lines join, and saves the answer', async () => {
    const calls: Call[] = [];
    let answered = 0;
    wrap(
      async (action, input) => (calls.push({ action, input }), ok()),
      <PickBar count={1} ready={0} busy={false} canPost onBook={() => undefined} onIgnore={() => undefined} onClear={() => undefined} askLearned={{ workspaceId: 'ws_test', onAnswered: () => (answered += 1) }} />,
    );
    expect(screen.getByText('Ab wie vielen gleichen Buchungen sollen gelernte Zeilen mitgebucht werden?')).toBeTruthy();
    expect((screen.getByRole('radio', { name: '5' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Nur sichere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(answered).toBe(1));
    expect(calls[0]).toMatchObject({ action: 'settings_set', input: { workspaceId: 'ws_test', key: 'bank.bulk_learned_min', value: 0 } });
  });

  it('the rule card asks the autobook threshold first (3, 5, 10) instead of offering the switch', async () => {
    const calls: Call[] = [];
    let changed = 0;
    const candidate = {
      standardId: 'bstd_1',
      label: null,
      counterparty: 'Fernmeldewerk Beispiel AG',
      eligible: true,
      ineligibleReason: null,
      cleanUses: 4,
      humanCleanUses: 4,
      ceilingPreview: { amountMinor: 1950, currency: 'CHF' },
      grant: null,
      offerActionId: null,
      grantable: false,
      asksThreshold: true,
    } satisfies AutobookCandidate;
    wrap(async (action, input) => (calls.push({ action, input }), ok()), <RuleAutopilotSwitch workspaceId="ws_test" candidate={candidate} offerAfter={5} onChanged={() => (changed += 1)} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Ab wie vielen unveränderten Buchungen darf eine Regel selbst buchen?')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(changed).toBe(1));
    expect(calls[0]).toMatchObject({ action: 'settings_set', input: { key: 'rules.autobook_offer_after', value: 3 } });
  });
});
