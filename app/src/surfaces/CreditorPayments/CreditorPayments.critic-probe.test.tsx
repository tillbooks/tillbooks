/**
 * The non-author critic's probes (critic/cl-creditor-payments, 35c912a2), flipped to assert the fix.
 *
 * P1 (F1, MEDIUM): a create whose answer was lost, followed by a re-read that reports the bill as
 * batched into the act's own landed batch, used to un-tick the bill and disable Generate, so the
 * same-key retry that replays that batch could never be made. P2 (F2, LOW): a create refused
 * `not_found` was worded as a discarded run. P3: a ticked bill that became batched ELSEWHERE, with
 * no act outstanding, is dropped by a re-read (held as asserted).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import CreditorPayments from './index';

const ok = (body: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...body } });
const BILL = {
  vendorId: 'contact_1', currency: 'CHF', vendorReference: null, hasCreditorProfile: true,
  creditorIban: 'CH9300762011623852957', creditorIbanMasked: '•••• 5295', isQrIban: false,
  referenceKind: 'free_text', referenceValid: true, batchable: true, alreadyBatchedInto: null as string | null,
};
const A = { ...BILL, billId: 'vb_a', vendorName: 'Alpha Probe', amountMinor: 10000, dueDate: '2099-11-02' };
const B = { ...BILL, billId: 'vb_b', vendorName: 'Beta Probe', amountMinor: 5000, dueDate: '2099-12-01' };
const NOPROF = { ...BILL, billId: 'vb_c', vendorName: 'Gamma Probe', amountMinor: 700, dueDate: '2099-12-01', hasCreditorProfile: false };
const ACCOUNT = { id: 'ba_chf', name: 'Hauptkonto CHF', iban: 'CH93', currency: 'CHF', receiveOnly: false, archived: false };
const caps = (held: string[]): Capabilities => ({
  whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'owner', capabilities: held },
  can: (c) => held.includes(c), refresh: () => undefined,
});
function mount(transport: Transport) {
  return render(
    <MemoryRouter initialEntries={['/creditor-payments']}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_a">
          <TillClientProvider client={new TillClient(transport)}>
            <CapabilitiesContext.Provider value={caps([CAP.pay, CAP.post, CAP.manageMasterData])}>
              <Routes><Route path="/creditor-payments" element={<CreditorPayments />} /></Routes>
            </CapabilitiesContext.Provider>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => installMemoryStorage());
const gen = () => screen.getByRole('button', { name: 'pain.001 generieren' });

describe('critic probes', () => {
  it('P1: create answer lost, then an IBAN save re-reads: the tick survives and the same-key retry replays the landed batch into a file', async () => {
    const user = userEvent.setup();
    // Engine model: key K creates pbatch_1 holding vb_a; the FIRST answer is lost on the wire, and a
    // later call under the same key replays pbatch_1.
    let landedKey: string | null = null;
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const t: Transport = async (action, input) => {
      calls.push({ action, input });
      if (action === 'list_payable') {
        return ok({ items: [landedKey !== null ? { ...A, alreadyBatchedInto: 'pbatch_1' } : A, B, NOPROF], total: 3, baseCurrency: 'CHF' });
      }
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'create_payment_batch') {
        if (landedKey === null) {
          landedKey = input.idempotencyKey as string;
          return { status: 0, body: { ok: false, error: 'transport_error' } };
        }
        if (input.idempotencyKey === landedKey) return ok({ batchId: 'pbatch_1', batch: { id: 'pbatch_1', status: 'draft' } });
        return { status: 409, body: { ok: false, error: 'already_batched', vendorBillId: 'vb_a' } };
      }
      if (action === 'generate_pain001') {
        return ok({
          batchId: input.batchId, xmlBase64: 'PERvY3VtZW50Lz4=', filename: 'pain001-pbatch_1.xml', valid: true, warnings: [],
          ctrlSumMinor: 10000, nbOfTxs: 1, transmitted: false, reason: 'no_channel',
          batch: { id: 'pbatch_1', bankAccountId: 'ba_chf', executionDate: '2099-01-01', status: 'generated', ctrlSumMinor: 10000, nbOfTxs: 1, msgId: 'PB-1', createdBy: null, createdAt: '2026-10-04T00:00:00.000Z', items: [] },
        });
      }
      if (action === 'set_creditor_bank_profile') return ok({ creditorBankProfileId: 'cbp', vendorId: 'contact_1' });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await waitFor(() => expect(gen()).toBeEnabled());
    await user.click(gen());
    await screen.findByRole('alert');
    // A save on another row re-reads the list.
    await user.click(screen.getByRole('button', { name: 'IBAN hinterlegen' }));
    await user.type(screen.getByPlaceholderText('CH.. / QR-IBAN'), 'CH9300762011623852957');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'list_payable')).toHaveLength(2));
    // Fixed: the act is outstanding, so the bill batched into its own landed batch stays ticked (and
    // can still be unticked), and Generate stays available for the retry.
    await waitFor(() => expect(calls.filter((c) => c.action === 'list_payable')).toHaveLength(2));
    await screen.findByText('Alpha Probe');
    const alpha = screen.getByRole('checkbox', { name: /Alpha Probe/ });
    expect(alpha).toBeChecked();
    expect(alpha).toBeEnabled();
    expect(gen()).toBeEnabled();
    await user.click(gen());
    await screen.findByText('Datei ist gültig');
    const creates = calls.filter((c) => c.action === 'create_payment_batch');
    expect(creates).toHaveLength(2);
    expect(creates[1].input.idempotencyKey).toBe(creates[0].input.idempotencyKey);
    expect(creates[1].input.itemIds).toEqual(['vb_a']);
    expect(calls.filter((c) => c.action === 'generate_pain001').map((c) => c.input.batchId)).toEqual(['pbatch_1']);
  });

  it('P1b: while the act is outstanding, a bill batched elsewhere can be unticked by the person (never a trapped tick)', async () => {
    const user = userEvent.setup();
    let failed = false;
    const t: Transport = async (action) => {
      if (action === 'list_payable') return ok({ items: [failed ? { ...A, alreadyBatchedInto: 'pbatch_other' } : A, NOPROF], total: 2, baseCurrency: 'CHF' });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'create_payment_batch') { failed = true; return { status: 0, body: { ok: false, error: 'transport_error' } }; }
      if (action === 'set_creditor_bank_profile') return ok({ creditorBankProfileId: 'cbp', vendorId: 'contact_1' });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await waitFor(() => expect(gen()).toBeEnabled());
    await user.click(gen());
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'IBAN hinterlegen' }));
    await user.type(screen.getByPlaceholderText('CH.. / QR-IBAN'), 'CH9300762011623852957');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.getByText('Bereits in einem Zahlungslauf')).toBeTruthy());
    const alpha = screen.getByRole('checkbox', { name: /Alpha Probe/ });
    expect(alpha).toBeChecked();
    await user.click(alpha);
    expect(alpha).not.toBeChecked();
    // Unticked, the blocked row cannot be ticked again.
    expect(alpha).toBeDisabled();
    expect(gen()).toBeDisabled();
  });

  it('P2: a create refused not_found (a bill) is NOT worded as "the run was discarded"', async () => {
    const user = userEvent.setup();
    const t: Transport = async (action) => {
      if (action === 'list_payable') return ok({ items: [A], total: 1, baseCurrency: 'CHF' });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'create_payment_batch') return { status: 422, body: { ok: false, error: 'not_found', vendorBillId: 'vb_a' } };
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await waitFor(() => expect(gen()).toBeEnabled());
    await user.click(gen());
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('verworfen');
  });

  it('P3: a still-listed ticked bill that became already-batched elsewhere is dropped by a re-read', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const t: Transport = async (action) => {
      if (action === 'list_payable') {
        reads += 1;
        return ok({ items: reads === 1 ? [A, NOPROF] : [{ ...A, alreadyBatchedInto: 'pbatch_x' }, NOPROF], total: 2, baseCurrency: 'CHF' });
      }
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'set_creditor_bank_profile') return ok({ creditorBankProfileId: 'cbp', vendorId: 'contact_1' });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await user.click(screen.getByRole('button', { name: 'IBAN hinterlegen' }));
    await user.type(screen.getByPlaceholderText('CH.. / QR-IBAN'), 'CH9300762011623852957');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Alpha Probe/ })).not.toBeChecked());
    expect(gen()).toBeDisabled();
  });

  it('M19: a bill that loses its IBAN while an act is outstanding is NOT kept ticked by the exception', async () => {
    const user = userEvent.setup();
    let failed = false;
    const calls: string[] = [];
    const t: Transport = async (action) => {
      calls.push(action);
      if (action === 'list_payable') {
        // After the lost create, the re-read lists vb_a as batched AND without a creditor profile.
        const a = failed ? { ...A, alreadyBatchedInto: 'pbatch_1', hasCreditorProfile: false } : A;
        return ok({ items: [a, NOPROF], total: 2, baseCurrency: 'CHF' });
      }
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'create_payment_batch') { failed = true; return { status: 0, body: { ok: false, error: 'transport_error' } }; }
      if (action === 'set_creditor_bank_profile') return ok({ creditorBankProfileId: 'cbp', vendorId: 'contact_1' });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await waitFor(() => expect(gen()).toBeEnabled());
    await user.click(gen());
    await screen.findByRole('alert');
    await user.click(screen.getAllByRole('button', { name: 'IBAN hinterlegen' })[0]);
    await user.type(screen.getByPlaceholderText('CH.. / QR-IBAN'), 'CH9300762011623852957');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.filter((c) => c === 'list_payable')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Alpha Probe/ })).not.toBeChecked());
    expect(gen()).toBeDisabled();
  });

  it('M23: generate refusing a LIVE batch with a non-stale error never says "verworfen" and creates no second run', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const t: Transport = async (action) => {
      calls.push(action);
      if (action === 'list_payable') return ok({ items: [A], total: 1, baseCurrency: 'CHF' });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'create_payment_batch') return ok({ batchId: 'pbatch_1', batch: { id: 'pbatch_1', status: 'draft' } });
      if (action === 'generate_pain001') return { status: 422, body: { ok: false, error: 'invalid_input', batchId: 'pbatch_1' } };
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await waitFor(() => expect(gen()).toBeEnabled());
    await user.click(gen());
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('verworfen');
    expect(calls.filter((c) => c === 'create_payment_batch')).toHaveLength(1);
    expect(calls.filter((c) => c === 'generate_pain001')).toHaveLength(1);
  });

  it('a create refused already_batched is said in words, with the way forward', async () => {
    const user = userEvent.setup();
    const t: Transport = async (action) => {
      if (action === 'list_payable') return ok({ items: [A], total: 1, baseCurrency: 'CHF' });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
      if (action === 'create_payment_batch') return { status: 409, body: { ok: false, error: 'already_batched', vendorBillId: 'vb_a', batchId: 'pbatch_x' } };
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    mount(t);
    await screen.findByText('Alpha Probe');
    await user.click(screen.getByRole('checkbox', { name: /Alpha Probe/ }));
    await waitFor(() => expect(gen()).toBeEnabled());
    await user.click(gen());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Diese Rechnung steckt schon in einem anderen Zahlungslauf. Nimm das Häkchen weg und generiere erneut.');
    // The generic body sentence is not what the person reads here.
    expect(alert).not.toHaveTextContent('Die Aktion konnte nicht abgeschlossen werden.');
  });
});
