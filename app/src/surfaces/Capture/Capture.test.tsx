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
