/**
 * A18 `CreditorPayments`, the five states plus the A24 padlock (F5 idiom).
 *
 * `create_payment_batch`/`generate_pain001` are PRE-DISABLED with a visible, aria-describedby reason
 * when the actor lacks `pay`, never shown then rejected on submit (spec §6, mirrors A17/A11's own
 * treatment); a disabled button's title is not announced, so the reason is a described-by note. `mark_batch_paid`
 * needs `pay` AND `post` (it reaches `postEntry` via A14), the `record_payment` ALL-OF shape.
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
import { watchReads, neverSettles } from '../../test-transport';
import CreditorPayments from './index';

const PAYABLE_ITEM = {
  billId: 'vbill_1',
  vendorId: 'contact_1',
  vendorName: 'Lieferant GmbH',
  currency: 'CHF',
  amountMinor: 108100,
  dueDate: '2026-08-15',
  vendorReference: 'LG-0042',
  hasCreditorProfile: true,
  creditorIban: 'CH9300762011623852957',
  creditorIbanMasked: '•••• 5295',
  isQrIban: false,
  referenceKind: 'free_text',
  referenceValid: true,
  batchable: true,
  alreadyBatchedInto: null,
};

// A fresh-workspace row: the vendor has no creditor profile yet, so the only path forward is to
// capture the IBAN in-surface (F8). Without that surface every row here is a dead end.
const PAYABLE_NO_PROFILE = {
  ...PAYABLE_ITEM,
  hasCreditorProfile: false,
  creditorIban: null,
  creditorIbanMasked: null,
  isQrIban: null,
  referenceKind: 'none',
};

const BANK_ACCOUNT = {
  id: 'ba_1',
  // The engine's BankAccountView carries the account currency; the debit default keys on it (critic F4).
  currency: 'CHF',
  name: 'Kantonalbank Kontokorrent',
  iban: 'CH93 0076 2011 6238 5295 7',
  receiveOnly: false,
  archived: false,
};

const BATCH_DRAFT = {
  id: 'pbatch_1',
  bankAccountId: 'ba_1',
  executionDate: '2026-08-01',
  status: 'draft',
  ctrlSumMinor: null,
  nbOfTxs: null,
  msgId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  items: [],
};

const BATCH_GENERATED = {
  ...BATCH_DRAFT,
  status: 'generated',
  ctrlSumMinor: 108100,
  nbOfTxs: 1,
  msgId: 'PB-pbatch-1',
  items: [
    {
      id: 'pbitem_1',
      vendorBillId: 'vbill_1',
      vendorId: 'contact_1',
      vendorName: 'Lieferant GmbH',
      amountMinor: 108100,
      currency: 'CHF',
      creditorIbanMasked: '•••• 5295',
      isQrIban: false,
      referenceKind: 'none',
      postedPaymentId: null,
    },
  ],
};

const BATCH_PAID = { ...BATCH_GENERATED, status: 'paid' };

function ok(body: Record<string, unknown>): RestResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function transportFor(overrides: Record<string, RestResponse | undefined>): Transport {
  return async (action) => {
    if (overrides[action] !== undefined) return overrides[action] as RestResponse;
    if (action === 'list_payable') return ok({ items: [PAYABLE_ITEM], total: 1 });
    if (action === 'list_bank_accounts') return ok({ bankAccounts: [BANK_ACCOUNT] });
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: {
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm1',
      userId: 'u1',
      role: 'viewer',
      capabilities: [...held],
    },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

function renderWith(transport: Transport, held: readonly string[] = [CAP.pay, CAP.post]) {
  return render(
    <MemoryRouter initialEntries={['/creditor-payments']}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={new TillClient(transport)}>
            <CapabilitiesContext.Provider value={caps(held)}>
              <Routes>
                <Route path="/creditor-payments" element={<CreditorPayments />} />
              </Routes>
            </CapabilitiesContext.Provider>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installMemoryStorage();
});

describe('CreditorPayments, the five states', () => {
  it('LOADING: shows a skeleton once the payable read has genuinely started', async () => {
    const transport = watchReads(neverSettles);
    renderWith(transport);
    await transport.started('list_payable');
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('EMPTY: "Nichts zu bezahlen" with a link back to Bills, never a bare "No data"', async () => {
    renderWith(transportFor({ list_payable: ok({ items: [], total: 0 }) }));
    expect(await screen.findByText('Nichts zu bezahlen')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Kreditorenrechnungen/ }).length).toBeGreaterThan(0);
  });

  it('ERROR: a failed payable read shows the banner with a retry', async () => {
    renderWith(transportFor({ list_payable: { status: 500, body: { ok: false, error: 'transport_error' } } }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /erneut|retry/i })).toBeTruthy();
  });

  it('PERMISSION-DENIED: a denied read shows the padlock panel, not the list', async () => {
    renderWith(transportFor({ list_payable: { status: 403, body: { ok: false, error: 'permission_denied' } } }));
    expect(await screen.findByText(/keine Berechtigung/)).toBeTruthy();
  });

  it('SUCCESS: lists the payable bill, selects it, generates, and offers the download', async () => {
    const user = userEvent.setup();
    renderWith(
      transportFor({
        create_payment_batch: ok({ batchId: 'pbatch_1', batch: BATCH_DRAFT }),
        generate_pain001: ok({
          batchId: 'pbatch_1',
          xmlBase64: Buffer.from('<Document/>').toString('base64'),
          filename: 'pain001-pbatch_1.xml',
          valid: true,
          warnings: [],
          ctrlSumMinor: 108100,
          nbOfTxs: 1,
          transmitted: false,
          reason: 'no_channel',
          batch: BATCH_GENERATED,
        }),
      }),
    );

    await screen.findByText('Lieferant GmbH');
    // F-03 (J3.4): the bill is due (2026-08-15) by today's execution date, so it arrives pre-ticked.
    const checkbox = screen.getByRole('checkbox', { name: /Lieferant GmbH/ });
    expect(checkbox).toBeChecked();

    const generate = screen.getByRole('button', { name: 'pain.001 generieren' });
    // The debit account defaults once the account read lands (F-03, J3.4), which enables Generate.
    await waitFor(() => expect(generate).not.toHaveProperty('disabled', true));
    await user.click(generate);

    expect(await screen.findByText('Datei ist gültig')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Datei herunterladen' })).toBeTruthy();
    // The no-channel floor: A33 does not exist in this codebase, so the note is always the manual one.
    expect(screen.getByText(/lade sie selbst in dein E-Banking hoch/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Als bezahlt markieren' })).toBeTruthy();
  });

  it('F-03 (J3.4): pre-selects the bills due by the execution date, in one currency, and debits the account in that currency', async () => {
    const user = userEvent.setup();
    const today = new Date().toISOString().slice(0, 10);
    const dueChf = { ...PAYABLE_ITEM, billId: 'vb_due', vendorName: 'Fällig AG', dueDate: '2026-08-15' };
    const laterChf = { ...PAYABLE_ITEM, billId: 'vb_later', vendorName: 'Später GmbH', dueDate: '2099-01-01' };
    const dueEur = { ...PAYABLE_ITEM, billId: 'vb_eur', vendorName: 'Euro SARL', currency: 'EUR', dueDate: '2026-08-01' };
    const eurAccount = { ...BANK_ACCOUNT, id: 'ba_eur', name: 'Euro-Konto', currency: 'EUR' };
    const chfAccount = { ...BANK_ACCOUNT, id: 'ba_chf', name: 'Kantonalbank Kontokorrent', currency: 'CHF' };
    renderWith(async (action) => {
      if (action === 'list_payable') return ok({ items: [dueChf, laterChf, dueEur], total: 3, baseCurrency: 'CHF' });
      // The EUR account is listed FIRST: the naive default the golden ledger measured.
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [eurAccount, chfAccount] });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    });
    await screen.findByText('Fällig AG');
    // The EUR bill is due earlier, but the books are kept in CHF and a CHF bill is due: the batch is
    // CHF, only the due CHF bill ticks, and the debit account is the CHF one (never the EUR account
    // listed first).
    expect(screen.getByRole('checkbox', { name: /Fällig AG/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Euro SARL/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Später GmbH/ })).not.toBeChecked();
    await waitFor(() => expect(screen.getByLabelText('Belastungskonto')).toHaveValue('ba_chf'));
    // Untick the CHF bill and tick the EUR one: the debit account follows the currency.
    await user.click(screen.getByRole('checkbox', { name: /Fällig AG/ }));
    await user.click(screen.getByRole('checkbox', { name: /Euro SARL/ }));
    await waitFor(() => expect(screen.getByLabelText('Belastungskonto')).toHaveValue('ba_eur'));
    expect(today >= '2026-08-15').toBe(true);
  });

  // Critic F4 (2026-09-05): the default fell back to the first eligible account of ANY currency and
  // the engine does not refuse the mismatch, so a CHF batch would have debited the EUR account with
  // ok:true. Restore the `?? eligible[0]?.id` fallback and this fails on the EUR value.
  it('F-03 (J3.4, critic F4): with no account in the batch currency nothing is pre-selected and Generate waits for a deliberate pick', async () => {
    const user = userEvent.setup();
    const dueChf = { ...PAYABLE_ITEM, billId: 'vb_due', vendorName: 'Fällig AG', dueDate: '2026-08-15' };
    const eurAccount = { ...BANK_ACCOUNT, id: 'ba_eur', name: 'Euro-Konto', currency: 'EUR' };
    renderWith(async (action) => {
      if (action === 'list_payable') return ok({ items: [dueChf], total: 1, baseCurrency: 'CHF' });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [eurAccount] });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    });
    await screen.findByText('Fällig AG');
    expect(screen.getByRole('checkbox', { name: /Fällig AG/ })).toBeChecked();
    const account = screen.getByLabelText('Belastungskonto');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Konto in CHF wählen' })).toBeInTheDocument());
    expect(account).toHaveValue('');
    expect(screen.getByRole('button', { name: 'pain.001 generieren' })).toBeDisabled();
    // A person may still settle the CHF bill from the EUR account, on purpose: the pick enables the act.
    await user.selectOptions(account, 'ba_eur');
    expect(account).toHaveValue('ba_eur');
    await waitFor(() => expect(screen.getByRole('button', { name: 'pain.001 generieren' })).toBeEnabled());
  });

  it('marks a generated batch paid after the explicit confirm, never on the click alone', async () => {
    const user = userEvent.setup();
    renderWith(
      transportFor({
        create_payment_batch: ok({ batchId: 'pbatch_1', batch: BATCH_DRAFT }),
        generate_pain001: ok({
          batchId: 'pbatch_1',
          xmlBase64: Buffer.from('<Document/>').toString('base64'),
          filename: 'pain001-pbatch_1.xml',
          valid: true,
          warnings: [],
          ctrlSumMinor: 108100,
          nbOfTxs: 1,
          transmitted: false,
          reason: 'no_channel',
          batch: BATCH_GENERATED,
        }),
        mark_batch_paid: ok({ batchId: 'pbatch_1', paymentIds: ['pay_1'], batch: BATCH_PAID }),
      }),
    );

    await screen.findByText('Lieferant GmbH');
    expect(screen.getByRole('checkbox', { name: /Lieferant GmbH/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'pain.001 generieren' }));
    await screen.findByText('Datei ist gültig');

    await user.click(screen.getByRole('button', { name: 'Als bezahlt markieren' }));
    // The confirm dialog demands its own explicit checkbox: the Mark-paid click alone posts nothing.
    const confirmButton = screen.getByRole('button', { name: 'Bestätigen' });
    expect(confirmButton).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('checkbox', { name: /bestätige/ }));
    await user.click(confirmButton);

    await waitFor(() => expect(screen.getByText('Bezahlt')).toBeTruthy());
  });
});

describe('CreditorPayments, capturing a creditor IBAN (F8)', () => {
  it('a row without a profile offers Add IBAN, and saving it calls set_creditor_bank_profile', async () => {
    const user = userEvent.setup();
    const calls: { action: string; input: unknown }[] = [];
    const transport: Transport = async (action, input) => {
      calls.push({ action, input });
      if (action === 'set_creditor_bank_profile') return ok({ creditorBankProfileId: 'cbp_1', vendorId: 'contact_1' });
      if (action === 'list_payable') return ok({ items: [PAYABLE_NO_PROFILE], total: 1 });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [BANK_ACCOUNT] });
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    renderWith(transport, [CAP.pay, CAP.post, CAP.manageMasterData]);

    await screen.findByText('Lieferant GmbH');
    // The dead-end hint is now an actionable button.
    const addBtn = await screen.findByRole('button', { name: 'IBAN hinterlegen' });
    await user.click(addBtn);

    const ibanField = screen.getByPlaceholderText('CH.. / QR-IBAN');
    await user.type(ibanField, 'CH9300762011623852957');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() =>
      expect(calls.some((c) => c.action === 'set_creditor_bank_profile')).toBe(true),
    );
    const call = calls.find((c) => c.action === 'set_creditor_bank_profile');
    expect((call?.input as { vendorId: string }).vendorId).toBe('contact_1');
    expect((call?.input as { iban: string }).iban).toBe('CH9300762011623852957');
  });

  it('without manage_master_data the Add IBAN button is disabled with a VISIBLE, described-by reason (a disabled title is not announced)', async () => {
    renderWith(transportFor({ list_payable: ok({ items: [PAYABLE_NO_PROFILE], total: 1 }) }), ['pay']);
    await screen.findByText('Lieferant GmbH');
    const addBtn = screen.getByRole('button', { name: 'IBAN hinterlegen' });
    expect(addBtn).toHaveProperty('disabled', true);
    // f2: the reason is no longer a silent title on the disabled button; it is a visible note the
    // button points at via aria-describedby, so assistive tech announces it.
    expect(addBtn.getAttribute('title')).toBeNull();
    expect(addBtn.getAttribute('aria-describedby')).toBe('pay-profile-denied');
    const note = document.getElementById('pay-profile-denied');
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent('Erfordert die Berechtigung Stammdaten');
  });
});

describe('CreditorPayments, the A24 padlock (F5)', () => {
  it('holding pay alone leaves Generate enabled once a bill and account are picked (pay suffices)', async () => {
    renderWith(transportFor({}), ['pay']);
    await screen.findByText('Lieferant GmbH');
    expect(screen.getByRole('checkbox', { name: /Lieferant GmbH/ })).toBeChecked();
    const generate = screen.getByRole('button', { name: 'pain.001 generieren' });
    await waitFor(() => expect(generate).toHaveProperty('disabled', false));
  });

  it('holding neither pay nor post pre-disables Generate even with a bill selected, a VISIBLE described-by note naming the gap', async () => {
    renderWith(transportFor({}), ['read_books']);
    await screen.findByText('Lieferant GmbH');
    expect(screen.getByRole('checkbox', { name: /Lieferant GmbH/ })).toBeChecked();
    const generate = screen.getByRole('button', { name: 'pain.001 generieren' });
    expect(generate).toHaveProperty('disabled', true);
    // f2: the gap is named by a visible note (announced via aria-describedby), not a silent title.
    expect(generate.getAttribute('title')).toBeNull();
    expect(generate.getAttribute('aria-describedby')).toBe('pay-generate-denied');
    const note = document.getElementById('pay-generate-denied');
    expect(note).not.toBeNull();
    expect(note).toHaveTextContent('Erfordert die Berechtigung Zahlungen');
  });

  it('holding pay but not post pre-disables Mark-paid on a generated batch with a VISIBLE described-by note', async () => {
    const user = userEvent.setup();
    // `pay` generates the batch; `mark_batch_paid` also needs `post`, so the mark-paid control is
    // pre-disabled and names its gap in a visible, announced note (not a silent title).
    renderWith(
      transportFor({
        create_payment_batch: ok({ batchId: 'pbatch_1', batch: BATCH_DRAFT }),
        generate_pain001: ok({
          batchId: 'pbatch_1',
          xmlBase64: Buffer.from('<Document/>').toString('base64'),
          filename: 'pain001-pbatch_1.xml',
          valid: true,
          warnings: [],
          ctrlSumMinor: 108100,
          nbOfTxs: 1,
          transmitted: false,
          reason: 'no_channel',
          batch: BATCH_GENERATED,
        }),
      }),
      ['pay'],
    );
    await screen.findByText('Lieferant GmbH');
    expect(screen.getByRole('checkbox', { name: /Lieferant GmbH/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'pain.001 generieren' }));
    const markPaid = await screen.findByRole('button', { name: 'Als bezahlt markieren' });
    expect(markPaid).toHaveProperty('disabled', true);
    expect(markPaid.getAttribute('title')).toBeNull();
    expect(markPaid.getAttribute('aria-describedby')).toBe('pay-markpaid-denied');
    expect(document.getElementById('pay-markpaid-denied')).not.toBeNull();
  });
});

describe('CreditorPayments: C3 provenance', () => {
  function generateWith(batch: Record<string, unknown>) {
    return transportFor({
      create_payment_batch: ok({ batchId: 'pbatch_1', batch: BATCH_DRAFT }),
      generate_pain001: ok({
        batchId: 'pbatch_1',
        xmlBase64: Buffer.from('<Document/>').toString('base64'),
        filename: 'pain001-pbatch_1.xml',
        valid: true,
        warnings: [],
        ctrlSumMinor: 108100,
        nbOfTxs: 1,
        transmitted: false,
        reason: 'no_channel',
        batch,
      }),
    });
  }

  it('names the actor that created the batch, verbatim from the batch header', async () => {
    const user = userEvent.setup();
    renderWith(generateWith({ ...BATCH_GENERATED, createdBy: 'm.keller' }));
    await screen.findByText('Lieferant GmbH');
    expect(screen.getByRole('checkbox', { name: /Lieferant GmbH/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'pain.001 generieren' }));
    await screen.findByText('Datei ist gültig');
    expect(screen.getByText(/Erfasst durch m\.keller/)).toBeTruthy();
  });

  it('shows the neutral form and no fabricated name when the batch has no actor', async () => {
    const user = userEvent.setup();
    renderWith(generateWith({ ...BATCH_GENERATED, createdBy: null }));
    await screen.findByText('Lieferant GmbH');
    expect(screen.getByRole('checkbox', { name: /Lieferant GmbH/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'pain.001 generieren' }));
    await screen.findByText('Datei ist gültig');
    expect(screen.getByText(/^Erfasst,/)).toBeTruthy();
    expect(screen.queryByText(/Erfasst durch/)).toBeNull();
  });
});
