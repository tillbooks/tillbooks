/**
 * A31, Belegeingang: the app-level suite. Every GUI state the spec §6 names, driven by canned engine
 * payloads whose SHAPE matches `core/purchase/capture.ts` (list_captures / get_capture / the writes).
 *
 * The strings asserted are the de-CH display forms (the default locale, as the A17 suite establishes):
 * a provenance badge reads "QR-Daten", an amount reads through `formatMoney`, and the empty states say
 * what the surface is for rather than "no data".
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { recordedOk } from '../../lib/test-support';
import Capture from './index';
// The chart the account picker is filled from is a RECORDING of the live `list_accounts` answer
// (pinned by `test/accounts/studio-list-accounts-fixture.test.mjs`), never a chart of this file's own.
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;
const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, seen?: string[]): Transport {
  return async (action, input) => {
    if (seen !== undefined) seen.push(action);
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const QUEUE_ONE = ok({
  captures: [
    { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null, fields: [] },
  ],
});

const DETAIL_WITH_FIELDS = ok({
  documentId: 'file_1',
  capture: { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
  fields: [
    { key: 'vendor_name', value: 'Lieferant GmbH', provenance: 'qr', confidence: 'high', superseded: false },
    { key: 'amount', value: { minor: 108100, currency: 'CHF' }, provenance: 'qr', confidence: 'high', superseded: false },
    { key: 'vendor_uid', value: '106017086', provenance: 'swico', confidence: 'high', superseded: false },
  ],
});

/** An account row from the recording, by its number. Throws rather than rendering `undefined`. */
function account(number: string) {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row;
}
/** The two the capture cases book against: the trade-goods purchase account and an admin expense. */
const ACC_4200 = account('4200');
const ACC_6500 = account('6500');

/** The pickers' sources (F-03, J3.1): the recorded chart and one vendor. */
const PICKER_READS: Canned = {
  list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
  list_contacts: ok({ contacts: [{ id: 'c_roest', name: 'Rösterei Nordlicht AG', partyRole: 'vendor' }] }),
  // Critic F3: the purchase-side codes the pane may post with (the output code is never offered).
  vat_codes: ok({
    taxCodes: [
      { code: 'VST-M', kind: 'input', rateBp: 0, formLine: '400', label: 'Vorsteuer Material, Waren, Dienstleistungen', active: true },
      { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, formLine: '383', label: 'Bezugsteuer', active: true },
      { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1%', active: true },
    ],
  }),
};

/** The engine's own rate resolution, canned: a zero-rate input code means the Normalsatz (810). */
const PREVIEW_NORMALSATZ = (input: Record<string, unknown>) =>
  ok({ kind: 'input', rateBp: input.taxCode === 'VST26' ? 260 : 810, netMinor: 10000, taxMinor: 810, grossMinor: 10810, deductible: true });

const DETAIL_EMPTY = ok({
  documentId: 'file_2',
  capture: { id: 'cap1', status: 'needs_review', qrPresent: false, swicoPresent: false, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
  fields: [],
});

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'u1', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'viewer', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

interface RenderOptions {
  route?: string;
  held?: readonly string[] | null;
  seen?: string[];
}

function renderCapture(canned: Canned, options: RenderOptions = {}) {
  const { route = '/capture-inbox', held = [CAP.manageFiles, CAP.post], seen } = options;
  const client = new TillClient(fakeTransport(canned, seen));
  const tree = (
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={client}>
            <Capture />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  return render(held === null ? tree : <CapabilitiesContext.Provider value={caps(held)}>{tree}</CapabilitiesContext.Provider>);
}

describe('the Belegeingang queue', () => {
  it('EMPTY: names what the surface is for, not "no data"', async () => {
    renderCapture({ list_captures: ok({ captures: [] }) });
    expect(await screen.findByText('Keine Belege zur Prüfung.')).toBeInTheDocument();
  });

  it('QUEUE + REVIEW: renders proposed fields with provenance and the formatted amount', async () => {
    renderCapture({ list_captures: QUEUE_ONE, get_capture: DETAIL_WITH_FIELDS }, { route: '/capture-inbox?capture=cap1' });
    // the field label and its QR provenance badge
    expect(await screen.findByText('Lieferant')).toBeInTheDocument();
    expect(screen.getAllByText('QR-Daten').length).toBeGreaterThan(0);
    expect(screen.getByText('Rechnungsinformationen (Swico)')).toBeInTheDocument();
    // the amount rendered through formatMoney (de-CH), not the raw 108100
    expect(screen.getByText(/1['’]?081\.00/)).toBeInTheDocument();
    expect(screen.queryByText('108100')).not.toBeInTheDocument();
  });

  it('DISCARDED (owner decision 01.10.2026): a correction a different bill reset shows as history with its reason; other history does not', async () => {
    const detail = ok({
      documentId: 'file_9',
      capture: { id: 'cap1', status: 'needs_review', qrPresent: false, swicoPresent: false, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
      fields: [
        { id: 'f_live', key: 'amount', value: { minor: 200000, currency: 'CHF' }, provenance: 'operator', confidence: 'high', superseded: false, qrPayloadId: 'capq_2', supersededReason: null },
        { id: 'f_old', key: 'amount', value: { minor: 432100, currency: 'CHF' }, provenance: 'operator', confidence: 'high', superseded: true, qrPayloadId: 'capq_1', supersededReason: null },
        { id: 'f_fix', key: 'amount', value: { minor: 98000, currency: 'CHF' }, provenance: 'operator', confidence: 'high', superseded: true, qrPayloadId: null, supersededReason: 'discarded_with_bill' },
      ],
    });
    renderCapture({ list_captures: QUEUE_ONE, get_capture: detail }, { route: '/capture-inbox?capture=cap1' });
    const section = await screen.findByRole('region', { name: 'Korrektur zur vorherigen Rechnung verworfen' });
    expect(section).toHaveTextContent('Diese Werte hattest du für eine andere Rechnung erfasst. Jetzt gilt die gelesene Rechnung. Prüfe sie, bevor du übernimmst. Kehrst du zu einer früheren Rechnung zurück, erfasse deine Korrekturen dort neu.');
    expect(section).toHaveTextContent(/980\.00/);
    // The other bill's superseded row is ordinary history, not a discarded correction.
    expect(section).not.toHaveTextContent(/4['’]?321\.00/);
    // The live proposal still shows the new bill's amount.
    expect(screen.getByText(/2['’]?000\.00/)).toBeInTheDocument();
  });

  it('DISCARDED: no section when nothing was discarded', async () => {
    renderCapture({ list_captures: QUEUE_ONE, get_capture: DETAIL_WITH_FIELDS }, { route: '/capture-inbox?capture=cap1' });
    expect(await screen.findByText('Lieferant')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Korrektur zur vorherigen Rechnung verworfen' })).not.toBeInTheDocument();
  });

  it('EMPTY EXTRACTION: an honest first-class state, naming the QR-less reason', async () => {
    renderCapture({ list_captures: QUEUE_ONE, get_capture: DETAIL_EMPTY }, { route: '/capture-inbox?capture=cap1' });
    expect(await screen.findByText('Keine Felder erkannt.')).toBeInTheDocument();
    expect(screen.getByText(/Kein QR-Code gefunden/)).toBeInTheDocument();
  });

  it('COMMIT (F-03, J3.1): one press commits AND posts, with the account typed by number and a vendor picked inline', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const seen: string[] = [];
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: DETAIL_WITH_FIELDS,
        ...PICKER_READS,
        list_vendor_bills: ok({ bills: [] }),
        capture_commit: (input) => {
          calls.push({ action: 'capture_commit', input });
          return ok({ captureId: 'cap1', targetKind: 'vendor_bill', targetId: 'vb_1' });
        },
        post_vendor_bill: (input) => {
          calls.push({ action: 'post_vendor_bill', input });
          return ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' });
        },
      },
      { route: '/capture-inbox?capture=cap1', seen },
    );
    const commit = await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    // No vendor matched and no account proposed: the act is not offered until both are answered.
    expect(commit).toBeDisabled();
    await userEvent.type(screen.getByRole('combobox', { name: 'Lieferant zuordnen' }), 'Röst');
    await userEvent.keyboard('{Enter}');
    const account = screen.getByRole('combobox', { name: 'Aufwandskonto' });
    await userEvent.type(account, '4200');
    await userEvent.keyboard('{Enter}');
    // Critic F3: no history and no Swico rate, so the code is the third answer the act waits for;
    // the sentence names the gap, then names what will post.
    expect(screen.getByText('Wähle zuerst den Vorsteuercode. Dann erstellt TILL die Lieferantenrechnung und bucht sie sofort.')).toBeInTheDocument();
    expect(commit).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Vorsteuer'));
    await userEvent.click(await screen.findByRole('option', { name: /^VST-M/ }));
    expect(screen.getByText('TILL erstellt die Lieferantenrechnung und bucht sie sofort, mit Vorsteuer VST-M.')).toBeInTheDocument();
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    await waitFor(() => expect(seen).toContain('post_vendor_bill'));
    expect(calls.map((c) => c.action)).toEqual(['capture_commit', 'post_vendor_bill']);
    const target = calls[0]?.input.target as Record<string, unknown>;
    expect(target).toMatchObject({ kind: 'vendor_bill', vendorId: 'c_roest', expenseAccountId: ACC_4200.id, taxCode: 'VST-M' });
    expect(calls[1]?.input).toMatchObject({ vendorBillId: 'vb_1' });
  });

  it('COMMIT (G04/A31 critic R1-H2): a currency_conflict refusal reads its own sentence through refusalText, and nothing posts', async () => {
    const seen: string[] = [];
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: DETAIL_WITH_FIELDS,
        ...PICKER_READS,
        list_vendor_bills: ok({ bills: [] }),
        // The engine's shape (`core/purchase/capture.ts` `commitCurrency`): the amount says one
        // currency, the read currency field another, and neither silently wins.
        capture_commit: () => ({
          status: 409,
          body: { ok: false, error: 'currency_conflict', captureId: 'cap1', amountCurrency: 'CHF', currency: 'EUR' },
        }),
        post_vendor_bill: () => ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' }),
      },
      { route: '/capture-inbox?capture=cap1', seen },
    );
    const commit = await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    await userEvent.type(screen.getByRole('combobox', { name: 'Lieferant zuordnen' }), 'Röst');
    await userEvent.keyboard('{Enter}');
    await userEvent.type(screen.getByRole('combobox', { name: 'Aufwandskonto' }), '4200');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByLabelText('Vorsteuer'));
    await userEvent.click(await screen.findByRole('option', { name: /^VST-M/ }));
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    expect(
      await screen.findByText('Betrag und Währung dieses Belegs widersprechen sich. Korrigiere den Betrag oder die Währung, bevor du übernimmst.'),
    ).toBeInTheDocument();
    expect(seen).toContain('capture_commit');
    expect(seen).not.toContain('post_vendor_bill');
  });

  it('COMMIT (F-03, J3.1): the account defaults from the matched vendor\'s last bill, and a double press replays the same keys', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const matched = ok({
      documentId: 'file_1',
      capture: { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
      fields: [
        { key: 'vendor_contact_id', value: 'c_roest', provenance: 'swico', confidence: 'high', superseded: false },
        { key: 'amount', value: { minor: 108100, currency: 'CHF' }, provenance: 'qr', confidence: 'high', superseded: false },
      ],
    });
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: matched,
        ...PICKER_READS,
        list_vendor_bills: ok({
          bills: [
            { id: 'vb_old', vendorId: 'c_roest', billDate: '2026-01-10', expenseAccountId: ACC_6500.id, createdAt: '2026-01-10T00:00:00.000Z', status: 'posted', taxCode: 'VST-M' },
            // The newest bill is still a DRAFT: its account counts, its code is not yet a decision.
            { id: 'vb_new', vendorId: 'c_roest', billDate: '2026-02-10', expenseAccountId: ACC_4200.id, createdAt: '2026-02-10T00:00:00.000Z', status: 'draft', taxCode: null },
          ],
        }),
        capture_commit: (input) => {
          calls.push({ action: 'capture_commit', input });
          return ok({ captureId: 'cap1', targetKind: 'vendor_bill', targetId: 'vb_1' });
        },
        post_vendor_bill: (input) => {
          calls.push({ action: 'post_vendor_bill', input });
          return ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' });
        },
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    const commit = await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    // Recognition over recall: the NEWEST bill's account (4200), not the older 6500.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Aufwandskonto' })).toHaveValue(`4200 ${ACC_4200.name}`));
    // The vendor is matched, so no vendor picker is asked for.
    expect(screen.queryByRole('combobox', { name: 'Lieferant zuordnen' })).toBeNull();
    // Critic F3: the Vorsteuer defaults from the vendor's newest POSTED bill and the sentence names
    // what will post, before the act.
    await waitFor(() => expect(screen.getByLabelText('Vorsteuer')).toHaveTextContent('VST-M'));
    expect(screen.getByText('TILL erstellt die Lieferantenrechnung und bucht sie sofort, mit Vorsteuer VST-M.')).toBeInTheDocument();
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.dblClick(commit);
    await waitFor(() => expect(calls.filter((c) => c.action === 'post_vendor_bill').length).toBeGreaterThan(0));
    // Whatever the press count, every commit and every post carries the SAME key: the engine's
    // replay answers the second press with the first result, and the ledger holds one entry.
    const commitKeys = new Set(calls.filter((c) => c.action === 'capture_commit').map((c) => c.input.idempotencyKey));
    const postKeys = new Set(calls.filter((c) => c.action === 'post_vendor_bill').map((c) => c.input.idempotencyKey));
    expect(commitKeys).toEqual(new Set(['capture-commit:cap1']));
    expect(postKeys).toEqual(new Set(['capture-post:cap1']));
    // Every commit carried the decided code: the bill posts WITH its Vorsteuer leg (the engine half
    // of this assertion is test/purchase/capture.test.mjs, "commit with a tax code ... 1170").
    for (const c of calls.filter((c) => c.action === 'capture_commit')) {
      expect(c.input.target).toMatchObject({ kind: 'vendor_bill', vendorId: 'c_roest', expenseAccountId: ACC_4200.id, taxCode: 'VST-M' });
    }
  });

  it('COMMIT (critic F3): with no vendor history the ONE input code whose rate matches the Swico rate defaults, resolved by vat_preview', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const swico = ok({
      documentId: 'file_1',
      capture: { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
      fields: [
        { key: 'vendor_contact_id', value: 'c_roest', provenance: 'swico', confidence: 'high', superseded: false },
        { key: 'amount', value: { minor: 108100, currency: 'CHF' }, provenance: 'qr', confidence: 'high', superseded: false },
        { key: 'vat_rate', value: '8.1', provenance: 'swico', confidence: 'high', superseded: false },
        { key: 'invoice_date', value: '2026-02-20', provenance: 'swico', confidence: 'high', superseded: false },
      ],
    });
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: swico,
        ...PICKER_READS,
        // Two input codes at different rates: 8.1 matches exactly one.
        vat_codes: ok({
          taxCodes: [
            { code: 'VST-M', kind: 'input', rateBp: 0, label: 'Vorsteuer Material', active: true },
            { code: 'VST26', kind: 'input', rateBp: 260, label: 'Vorsteuer reduziert', active: true },
          ],
        }),
        vat_preview: (input) => {
          calls.push({ action: 'vat_preview', input });
          return PREVIEW_NORMALSATZ(input);
        },
        list_vendor_bills: ok({ bills: [] }),
        capture_commit: (input) => {
          calls.push({ action: 'capture_commit', input });
          return ok({ captureId: 'cap1', targetKind: 'vendor_bill', targetId: 'vb_1' });
        },
        post_vendor_bill: ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' }),
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    await waitFor(() => expect(screen.getByLabelText('Vorsteuer')).toHaveTextContent('VST-M'));
    // The rate was resolved by the engine on the invoice date, never by a rate table in the Studio.
    expect(calls.filter((c) => c.action === 'vat_preview').map((c) => c.input)).toEqual(
      expect.arrayContaining([expect.objectContaining({ taxCode: 'VST-M', supplyDate: '2026-02-20', amountIsGross: false })]),
    );
    await userEvent.type(screen.getByRole('combobox', { name: 'Aufwandskonto' }), '4200{Enter}');
    const commit = screen.getByRole('button', { name: 'Übernehmen und buchen' });
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    await waitFor(() => expect(calls.some((c) => c.action === 'capture_commit')).toBe(true));
    expect(calls.find((c) => c.action === 'capture_commit')?.input.target).toMatchObject({ taxCode: 'VST-M' });
  });

  it('COMMIT (critic F3): when no code can be defaulted the act WAITS for the choice, and a hand-picked code is what posts', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const swico = ok({
      documentId: 'file_1',
      capture: { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
      fields: [
        { key: 'vendor_contact_id', value: 'c_roest', provenance: 'swico', confidence: 'high', superseded: false },
        { key: 'amount', value: { minor: 108100, currency: 'CHF' }, provenance: 'qr', confidence: 'high', superseded: false },
        { key: 'vat_rate', value: '8.1', provenance: 'swico', confidence: 'high', superseded: false },
      ],
    });
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: swico,
        ...PICKER_READS,
        // The default seed: VST-M and VST-I BOTH resolve to the Normalsatz, so nothing is proposed
        // (A31 §4: zero or several matches propose nothing).
        vat_codes: ok({
          taxCodes: [
            { code: 'VST-M', kind: 'input', rateBp: 0, label: 'Vorsteuer Material', active: true },
            { code: 'VST-I', kind: 'input', rateBp: 0, label: 'Vorsteuer Investitionen', active: true },
          ],
        }),
        vat_preview: PREVIEW_NORMALSATZ,
        list_vendor_bills: ok({ bills: [] }),
        capture_commit: (input) => {
          calls.push({ action: 'capture_commit', input });
          return ok({ captureId: 'cap1', targetKind: 'vendor_bill', targetId: 'vb_1' });
        },
        post_vendor_bill: ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' }),
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    const commit = await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    await userEvent.type(screen.getByRole('combobox', { name: 'Aufwandskonto' }), '4200{Enter}');
    // Account and vendor are set, the code is not: the button waits and the sentence says why.
    expect(screen.getByLabelText('Vorsteuer')).toHaveTextContent('Code wählen');
    expect(screen.getByText('Wähle zuerst den Vorsteuercode. Dann erstellt TILL die Lieferantenrechnung und bucht sie sofort.')).toBeInTheDocument();
    expect(commit).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Vorsteuer'));
    await userEvent.click(await screen.findByRole('option', { name: /^VST-I/ }));
    expect(screen.getByText('TILL erstellt die Lieferantenrechnung und bucht sie sofort, mit Vorsteuer VST-I.')).toBeInTheDocument();
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    await waitFor(() => expect(calls.some((c) => c.action === 'capture_commit')).toBe(true));
    expect(calls.find((c) => c.action === 'capture_commit')?.input.target).toMatchObject({ taxCode: 'VST-I' });
  });

  it('COMMIT (critic F3): a workspace with no purchase codes books without VAT, says so, and sends taxCode null', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const matched = ok({
      documentId: 'file_1',
      capture: { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
      fields: [
        { key: 'vendor_contact_id', value: 'c_roest', provenance: 'swico', confidence: 'high', superseded: false },
        { key: 'amount', value: { minor: 108100, currency: 'CHF' }, provenance: 'qr', confidence: 'high', superseded: false },
      ],
    });
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: matched,
        ...PICKER_READS,
        vat_codes: { status: 422, body: { ok: false, error: 'needs_vat_registration' } },
        list_vendor_bills: ok({ bills: [{ id: 'vb_old', vendorId: 'c_roest', billDate: '2026-01-10', expenseAccountId: ACC_6500.id, status: 'posted', taxCode: null }] }),
        capture_commit: (input) => {
          calls.push({ action: 'capture_commit', input });
          return ok({ captureId: 'cap1', targetKind: 'vendor_bill', targetId: 'vb_1' });
        },
        post_vendor_bill: ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' }),
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    const commit = await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    expect(await screen.findByText('TILL erstellt die Lieferantenrechnung und bucht sie sofort, ohne MWST.')).toBeInTheDocument();
    // Nothing to pick from: no picker is rendered.
    expect(screen.queryByLabelText('Vorsteuer')).toBeNull();
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    await waitFor(() => expect(calls.some((c) => c.action === 'capture_commit')).toBe(true));
    const target = calls.find((c) => c.action === 'capture_commit')?.input.target as Record<string, unknown>;
    expect(target).toHaveProperty('taxCode', null);
  });

  it('COMMIT (re-critic R2): the SECOND capture for a vendor in one session sees the bill the first act just posted (account and code)', async () => {
    const QUEUE_TWO = ok({
      captures: [
        { id: 'cap1', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null, fields: [] },
        { id: 'cap2', status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-02T09:00:00.000Z', targetKind: null, targetId: null, fields: [] },
      ],
    });
    const detail = (id: string) =>
      ok({
        documentId: `file_${id}`,
        capture: { id, status: 'needs_review', qrPresent: true, swicoPresent: true, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
        fields: [
          { key: 'vendor_contact_id', value: 'c_roest', provenance: 'swico', confidence: 'high', superseded: false },
          { key: 'amount', value: { minor: 108100, currency: 'CHF' }, provenance: 'qr', confidence: 'high', superseded: false },
          { key: 'vat_rate', value: '8.1', provenance: 'swico', confidence: 'high', superseded: false },
          { key: 'invoice_date', value: '2026-02-20', provenance: 'swico', confidence: 'high', superseded: false },
        ],
      });
    let posted = false;
    let listReads = 0;
    const targets: Record<string, unknown>[] = [];
    renderCapture(
      {
        list_captures: QUEUE_TWO,
        get_capture: (input) => {
          if (input.captureId === 'cap2') return detail('cap2');
          const d = detail('cap1');
          if (!posted) return d;
          const body = d.body as Record<string, unknown>;
          return ok({ ...body, capture: { ...(body.capture as Record<string, unknown>), status: 'committed', targetKind: 'vendor_bill', targetId: 'vb_1' } });
        },
        ...PICKER_READS,
        // Ambiguous codes: the vendor's history is the only thing that can default the code.
        vat_codes: ok({
          taxCodes: [
            { code: 'VST-M', kind: 'input', rateBp: 0, label: 'Material', active: true },
            { code: 'VST-I', kind: 'input', rateBp: 0, label: 'Investitionen', active: true },
          ],
        }),
        vat_preview: () => ok({ kind: 'input', rateBp: 810, netMinor: 10000, taxMinor: 810, grossMinor: 10810, deductible: true }),
        // Before the first act: no history. After it: the bill the act posted.
        list_vendor_bills: () => {
          listReads += 1;
          return posted
            ? ok({ bills: [{ id: 'vb_1', vendorId: 'c_roest', billDate: '2026-02-20', expenseAccountId: ACC_4200.id, createdAt: '2026-03-01T10:00:00.000Z', status: 'posted', taxCode: 'VST-I' }] })
            : ok({ bills: [] });
        },
        capture_commit: (input) => {
          targets.push(input.target as Record<string, unknown>);
          return ok({ captureId: String(input.captureId), targetKind: 'vendor_bill', targetId: 'vb_1' });
        },
        post_vendor_bill: () => {
          posted = true;
          return ok({ vendorBillId: 'vb_1', status: 'posted', entryId: 'je_1' });
        },
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    const commit = await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    await userEvent.type(screen.getByRole('combobox', { name: 'Aufwandskonto' }), '4200{Enter}');
    await userEvent.click(screen.getByLabelText('Vorsteuer'));
    await userEvent.click(await screen.findByRole('option', { name: /^VST-I/ }));
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    expect(await screen.findByText(/Übernommen und gebucht\./)).toBeInTheDocument();
    expect(targets[0]).toMatchObject({ taxCode: 'VST-I', expenseAccountId: ACC_4200.id });
    // Open the second capture for the same vendor: its newest posted bill now says VST-I and 4200.
    await userEvent.click(screen.getByText('02.03.2026'));
    await screen.findByRole('button', { name: 'Übernehmen und buchen' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Aufwandskonto' })).toHaveValue(`4200 ${ACC_4200.name}`));
    await waitFor(() => expect(screen.getByLabelText('Vorsteuer')).toHaveTextContent('VST-I'));
    expect(listReads).toBeGreaterThan(1);
  });

  it('PERMISSION: the drop-zone is hidden without manage_files and commit is disabled without post', async () => {
    renderCapture({ list_captures: QUEUE_ONE, get_capture: DETAIL_WITH_FIELDS }, { route: '/capture-inbox?capture=cap1', held: [CAP.readMasterData] });
    expect(await screen.findByText('Lieferant')).toBeInTheDocument();
    expect(screen.queryByLabelText('Beleg wählen')).not.toBeInTheDocument();
    const commit = screen.getByRole('button', { name: 'Übernehmen' });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute('title', 'Erfordert Buchhalterrolle');
    // Without `post` the act is plain "Übernehmen" and no posting consequence is promised.
    expect(screen.queryByText(/bucht sie sofort/)).toBeNull();
  });

  it('DISCARD: the row overflow action calls capture_discard', async () => {
    const seen: string[] = [];
    renderCapture({ list_captures: QUEUE_ONE, get_capture: DETAIL_WITH_FIELDS, capture_discard: ok({ captureId: 'cap1', status: 'discarded' }) }, { route: '/capture-inbox', seen });
    const more = await screen.findByRole('button', { name: 'Mehr' });
    await userEvent.click(more);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Verwerfen' }));
    await waitFor(() => expect(seen).toContain('capture_discard'));
  });

  it('DROP: a duplicate upload surfaces the honest notice', async () => {
    const seen: string[] = [];
    renderCapture(
      { list_captures: ok({ captures: [] }), capture_document: ok({ captureId: 'cap1', duplicate: true }) },
      { seen },
    );
    await screen.findByText('Keine Belege zur Prüfung.');
    const input = screen.getByLabelText('Beleg wählen');
    await userEvent.upload(input, new File(['%PDF-1.4'], 'beleg.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(seen).toContain('capture_document'));
    expect(await screen.findByText('Diese Datei ist bereits im Belegeingang.')).toBeInTheDocument();
  });
});

// --- A31 §0a: reading the bill's QR code in ------------------------------------------------------

/** A payload as a phone scanner hands it over. Its content is the engine's to judge; here it is text. */
const PASTED = 'SPC\n0200\n1\nCH4431999123000889012';

const DETAIL_AFTER_READ = ok({
  documentId: 'file_2',
  capture: { id: 'cap1', status: 'needs_review', qrPresent: false, swicoPresent: false, createdAt: '2026-03-01T09:00:00.000Z', targetKind: null, targetId: null },
  fields: [
    { id: 'f1', key: 'vendor_name', value: 'Beispiel Werkstatt AG', provenance: 'operator', confidence: 'high', superseded: false, qrPayloadId: 'capq_1' },
    { id: 'f2', key: 'vendor_address', value: { street: 'Talweg', buildingNumber: '7', postalCode: '3000', town: 'Bern', country: 'CH' }, provenance: 'operator', confidence: 'high', superseded: false, qrPayloadId: 'capq_1' },
    { id: 'f3', key: 'amount', value: { minor: 21540, currency: 'CHF' }, provenance: 'operator', confidence: 'high', superseded: false, qrPayloadId: null },
  ],
  qrPayloads: [{ id: 'capq_1', source: 'operator', decoder: 'pasted', fieldIds: ['f1', 'f2'] }],
});

describe('reading the QR code in (A31 §0a)', () => {
  it('READ IN: a pasted payload goes to capture_extract as the operator, and decoded fields say they came from the QR code', async () => {
    const calls: Record<string, unknown>[] = [];
    let read = false;
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: () => (read ? DETAIL_AFTER_READ : DETAIL_EMPTY),
        ...PICKER_READS,
        list_vendor_bills: ok({ bills: [] }),
        capture_extract: (input) => {
          calls.push(input);
          read = true;
          return ok({ captureId: 'cap1', fields: [], qrPayload: { id: 'capq_1', warnings: [] } });
        },
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    // Nothing to review yet, so the QR panel is open and its field is empty.
    const box = await screen.findByLabelText('Inhalt des QR-Codes');
    expect(box).toHaveValue('');
    const readIn = screen.getByRole('button', { name: 'Einlesen' });
    expect(readIn).toBeDisabled();
    await userEvent.click(box);
    await userEvent.paste(PASTED);
    await userEvent.click(readIn);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ captureId: 'cap1', source: 'operator', qrPayload: PASTED, decoder: 'pasted' });
    expect(await screen.findByText('Eingelesen. Bei jedem Feld steht, woher der Wert kommt.')).toBeInTheDocument();
    // The decoded rows carry the channel beside the provenance; the typed amount does not.
    expect(await screen.findAllByText('Manuell · aus dem QR-Code')).toHaveLength(2);
    expect(screen.getByText('Manuell')).toBeInTheDocument();
    expect(screen.getByText('Talweg 7, 3000 Bern, CH')).toBeInTheDocument();
    expect(screen.getByText('Adresse Lieferant')).toBeInTheDocument();
  });

  it('INVALID: every issue the decoder named is listed in de-CH with its line, and nothing is claimed as read', async () => {
    renderCapture(
      {
        list_captures: QUEUE_ONE,
        get_capture: DETAIL_EMPTY,
        ...PICKER_READS,
        capture_extract: {
          status: 422,
          body: {
            ok: false,
            error: 'qr_payload_invalid',
            errors: [
              { code: 'qrr_check_digit', element: 'RmtInf.Ref', line: 29, message: 'x' },
              { code: 'separator', element: 'payload', line: null, message: 'y' },
            ],
            warnings: [],
          },
        },
      },
      { route: '/capture-inbox?capture=cap1' },
    );
    const box = await screen.findByLabelText('Inhalt des QR-Codes');
    await userEvent.click(box);
    await userEvent.paste(PASTED);
    await userEvent.click(screen.getByRole('button', { name: 'Einlesen' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Dieser QR-Code hält die Regeln der QR-Rechnung nicht ein, darum wurde kein Feld ausgefüllt:');
    expect(alert).toHaveTextContent('Zeile 29: Die Prüfziffer der QR-Referenz stimmt nicht.');
    expect(alert).toHaveTextContent('Die Zeilenumbrüche sind gemischt');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveValue(PASTED);
    expect(screen.queryByText(/Eingelesen/)).toBeNull();
  });

  it('IMAGE: where the browser reads barcodes, a dropped photo pre-fills the field and the read-in names the reader', async () => {
    const scope = globalThis as Record<string, unknown>;
    const saved = { BarcodeDetector: scope.BarcodeDetector, createImageBitmap: scope.createImageBitmap };
    scope.BarcodeDetector = class {
      async detect() {
        return [{ rawValue: 'https://example.invalid' }, { rawValue: PASTED }];
      }
    };
    scope.createImageBitmap = async () => ({ close: () => undefined });
    try {
      const calls: Record<string, unknown>[] = [];
      renderCapture({
        list_captures: QUEUE_ONE,
        get_capture: DETAIL_EMPTY,
        ...PICKER_READS,
        capture_document: ok({ captureId: 'cap1', duplicate: false }),
        capture_extract: (input) => {
          calls.push(input);
          return ok({ captureId: 'cap1', fields: [], qrPayload: { id: 'capq_1', warnings: [] } });
        },
      });
      await userEvent.upload(await screen.findByLabelText('Beleg wählen'), new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'rechnung.png', { type: 'image/png' }));
      expect(await screen.findByText('Im Bild steht ein QR-Code. Prüf den Text und lies ihn dann ein.')).toBeInTheDocument();
      expect(screen.getByLabelText('Inhalt des QR-Codes')).toHaveValue(PASTED);
      // Found, not written: nothing reached the engine until the person reads it in.
      expect(calls).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Einlesen' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ source: 'operator', qrPayload: PASTED, decoder: 'studio-barcode-detector' });
    } finally {
      scope.BarcodeDetector = saved.BarcodeDetector;
      scope.createImageBitmap = saved.createImageBitmap;
    }
  });

  it('WITHOUT a barcode reader in the browser, an image drop pre-fills nothing', async () => {
    renderCapture({
      list_captures: QUEUE_ONE,
      get_capture: DETAIL_EMPTY,
      ...PICKER_READS,
      capture_document: ok({ captureId: 'cap1', duplicate: false }),
    });
    await userEvent.upload(await screen.findByLabelText('Beleg wählen'), new File([new Uint8Array([1, 2, 3])], 'rechnung.png', { type: 'image/png' }));
    expect(await screen.findByLabelText('Inhalt des QR-Codes')).toHaveValue('');
    expect(screen.queryByText(/Im Bild steht ein QR-Code/)).toBeNull();
  });

  it('PERMISSION: without the file right the QR panel is not offered', async () => {
    renderCapture({ list_captures: QUEUE_ONE, get_capture: DETAIL_EMPTY, ...PICKER_READS }, { route: '/capture-inbox?capture=cap1', held: [CAP.post] });
    await screen.findByText('Keine Felder erkannt.');
    expect(screen.queryByLabelText('Inhalt des QR-Codes')).toBeNull();
  });
});
