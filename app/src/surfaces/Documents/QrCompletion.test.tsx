/**
 * P0.4e: the first invoice ASKS for the creditor address, the IBAN and the customer address before it
 * issues, so the QR-bill renders instead of going out without one.
 *
 * The first-run audit issued R-2026-0001 with no payment part because nothing asked for either
 * address. Claims pinned here:
 *
 *   - the dialog shows exactly the missing blocks, prefilled with what is stored;
 *   - a complete answer runs the OWNING verbs' calls (`set_creditor_profile`, `update_contact`, the
 *     shapes `test/sales/first-invoice-qr-readiness.test.mjs` proves the engine turns into a QR-bill)
 *     and only then issues;
 *   - leaving the fields blank issues exactly as before (never a blocker, A11-G9);
 *   - a half-filled block or a bad IBAN saves nothing and issues nothing;
 *   - a refused save issues nothing and says why.
 *
 * Copy is asserted through the catalogue, never as a literal typed here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { IssueDialog } from './IssueDialog';
import { hasQrFixNeeds, initialQrFixValues, planQrFix, type QrFixCall, type QrFixNeeds } from './QrCompletion';
import { creditorAddressComplete, qrGapLines, qrReadiness, isQrReady } from './invoice';
import de from './messages.de-CH.json';

const NEEDS_ALL: QrFixNeeds = { iban: true, creditorAddress: true, customer: { contactId: 'ct_1', name: 'Muster AG' } };
const INITIAL = initialQrFixValues({ creditor: { name: null, address: null }, companyName: 'Beispiel GmbH', customerAddress: null });

describe('the QR completion plan (pure)', () => {
  it('starts from what is stored: the company name, CH, and a customer address already on file', () => {
    expect(INITIAL.creditorName).toBe('Beispiel GmbH');
    expect(INITIAL.creditorCountry).toBe('CH');
    expect(INITIAL.customerCountry).toBe('CH');
    const partial = initialQrFixValues({
      creditor: { name: 'Beispiel Handel', address: { street: 'Seestrasse', buildingNo: '', zip: '8001', town: 'Zürich', country: 'CH' } },
      companyName: 'Beispiel GmbH',
      customerAddress: { street: 'Musterweg', houseNo: '7', zip: null, city: null, country: 'CH' },
    });
    expect(partial.creditorName).toBe('Beispiel Handel');
    expect(partial.creditorStreet).toBe('Seestrasse');
    expect(partial.customerStreet).toBe('Musterweg');
    expect(partial.customerHouseNo).toBe('7');
  });

  it('untouched fields plan nothing: the invoice issues as before', () => {
    expect(planQrFix(NEEDS_ALL, INITIAL, INITIAL)).toEqual({ kind: 'none' });
  });

  it('a complete answer becomes the owning verbs\' calls, one per owner, in the engine\'s own field names', () => {
    const values = {
      ...INITIAL,
      creditorStreet: 'Seestrasse',
      creditorBuildingNo: '12',
      creditorZip: '8001',
      creditorTown: 'Zürich',
      creditorCountry: 'ch',
      iban: 'ch93 0076 2011 6238 5295 7',
      customerStreet: 'Musterweg',
      customerHouseNo: '',
      customerZip: '3000',
      customerCity: 'Bern',
    };
    const plan = planQrFix(NEEDS_ALL, INITIAL, values);
    expect(plan).toEqual({
      kind: 'save',
      calls: [
        {
          action: 'set_creditor_profile',
          input: {
            creditorName: 'Beispiel GmbH',
            address: { street: 'Seestrasse', buildingNo: '12', zip: '8001', town: 'Zürich', country: 'CH' },
            iban: 'CH9300762011623852957',
          },
        },
        {
          action: 'update_contact',
          input: { contactId: 'ct_1', patch: { address: { street: 'Musterweg', houseNo: '', zip: '3000', city: 'Bern', country: 'CH' } } },
        },
      ],
    });
  });

  it('a half-filled block, or an IBAN that is not one, plans nothing to save', () => {
    const half = planQrFix(NEEDS_ALL, INITIAL, { ...INITIAL, creditorStreet: 'Seestrasse' });
    expect(half).toEqual({ kind: 'incomplete', blocks: ['creditor'], invalidIban: false });
    const badIban = planQrFix(NEEDS_ALL, INITIAL, { ...INITIAL, iban: 'CH00 1234' });
    expect(badIban).toEqual({ kind: 'incomplete', blocks: [], invalidIban: true });
  });

  it('only the blocks that are asked for can be saved', () => {
    const onlyCustomer: QrFixNeeds = { iban: false, creditorAddress: false, customer: { contactId: 'ct_1', name: 'Muster AG' } };
    expect(hasQrFixNeeds(onlyCustomer)).toBe(true);
    expect(hasQrFixNeeds({ iban: false, creditorAddress: false, customer: null })).toBe(false);
    // Typing into a creditor field that is not asked for cannot produce a creditor call.
    const plan = planQrFix(onlyCustomer, INITIAL, { ...INITIAL, creditorStreet: 'X', customerStreet: 'Y', customerZip: '1', customerCity: 'Z' });
    expect(plan.kind).toBe('save');
    expect(plan.kind === 'save' && plan.calls.map((c) => c.action)).toEqual(['update_contact']);
  });

  it('readiness now counts the creditor address, which the engine refuses as needs_creditor_address', () => {
    expect(creditorAddressComplete({ name: 'Beispiel GmbH', address: null })).toBe(false);
    expect(creditorAddressComplete({ name: 'Beispiel GmbH', address: { street: 'S', buildingNo: '1', zip: '8', town: 'T', country: 'CH' } })).toBe(true);
    expect(creditorAddressComplete({ name: '', address: { street: 'S', buildingNo: '1', zip: '8', town: 'T', country: 'CH' } })).toBe(false);
    const contact = { id: 'ct_1', name: 'Muster AG', address: { street: 'Musterweg', houseNo: '7', zip: '3000', city: 'Bern', country: 'CH' } };
    const withoutCreditor = qrReadiness({ contact, iban: 'CH9300762011623852957', currency: 'CHF', issueDate: '2026-09-30', creditor: { name: 'X', address: null } });
    expect(isQrReady(withoutCreditor)).toBe(false);
    expect(qrGapLines(withoutCreditor).map((g) => g.key)).toEqual(['invoice.qr.needsCreditorAddress']);
    // Not loaded is not a gap: an unknown creditor is never reported.
    expect(isQrReady(qrReadiness({ contact, iban: 'CH9300762011623852957', currency: 'CHF', issueDate: '2026-09-30' }))).toBe(true);
  });

  // Critic phase0-installable r2, R2-2: the readiness runs the engine's OWN value rules
  // (qrAddressValueIssues), so a stored value the payment part refuses is a gap, not "QR-ready".
  it('a customer address the QR-bill would refuse is a gap: a non alpha-2 country, an over-long town or number', () => {
    const base = { street: 'Musterweg', houseNo: '7', zip: '3000', city: 'Bern', country: 'CH' };
    const readiness = (address: typeof base) =>
      qrReadiness({ contact: { id: 'ct_1', name: 'Muster AG', address }, iban: 'CH9300762011623852957', currency: 'CHF', issueDate: '2026-09-30' });
    expect(readiness({ ...base, country: 'Schweiz' }).missingCustomerAddress).toEqual(['country']);
    expect(readiness({ ...base, city: 'B'.repeat(36) }).missingCustomerAddress).toEqual(['city']);
    expect(readiness({ ...base, houseNo: '1'.repeat(17) }).missingCustomerAddress).toEqual(['houseNo']);
    expect(isQrReady(readiness({ ...base, country: 'Schweiz' }))).toBe(false);
    expect(qrGapLines(readiness({ ...base, country: 'Schweiz' })).map((g) => g.key)).toEqual(['invoice.qr.missingAddress']);
    // A foreign alpha-2 country and the IG maxima themselves are fine.
    expect(readiness({ ...base, country: 'de', city: 'B'.repeat(35) }).missingCustomerAddress).toEqual([]);
    // A blank field is listed once, as missing, never twice.
    expect(readiness({ ...base, country: '' }).missingCustomerAddress).toEqual(['country']);
  });
});

describe('IssueDialog asks before the first invoice issues', () => {
  function renderDialog(
    opts: {
      onSave?: (calls: QrFixCall[]) => Promise<null | { ok: false; error: string }>;
      needs?: QrFixNeeds;
      customerAddress?: { street: string; houseNo: string; zip: string; city: string; country: string };
    } = {},
  ) {
    const initial =
      opts.customerAddress === undefined
        ? INITIAL
        : initialQrFixValues({ creditor: { name: null, address: null }, companyName: 'Beispiel GmbH', customerAddress: opts.customerAddress });
    const onConfirm = vi.fn();
    const onSave = vi.fn(opts.onSave ?? (async () => null));
    render(
      <I18nProvider>
        <MemoryRouter>
          <IssueDialog
            posts
            isInvoice
            totalMinor={32430}
            currency="CHF"
            qrGaps={[{ key: 'invoice.qr.needsCreditorAddress' }, { key: 'invoice.qr.missingAddress', fields: ['street'] }]}
            qrFix={{ needs: opts.needs ?? NEEDS_ALL, initial, onSave: onSave as never }}
            busy={false}
            error={null}
            onConfirm={onConfirm}
            onCancel={() => {}}
          />
        </MemoryRouter>
      </I18nProvider>,
    );
    return { onConfirm, onSave };
  }

  const field = (name: string) => screen.getAllByRole('textbox', { name });

  it('shows exactly the missing blocks, prefilled, and leaving them blank issues as before', async () => {
    const { onConfirm, onSave } = renderDialog();
    expect(screen.getByText(de.invoice.qrFix.title)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: de.invoice.qrFix.creditorHeading })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: de.invoice.qrFix.ibanHeading })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: de.invoice.qrFix.customerHeading.replace('{name}', 'Muster AG') })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: de.invoice.qrFix.field.name })).toHaveValue('Beispiel GmbH');
    // The fixable gaps are asked for, not listed twice as a consequence.
    expect(screen.queryByText(de.invoice.issue.noQrLine)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: de.document.issue.confirm }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a complete answer saves through the owning verbs, THEN issues, under a label that says both', async () => {
    const { onConfirm, onSave } = renderDialog({ needs: { iban: false, creditorAddress: true, customer: null } });
    await userEvent.type(field(de.invoice.qrFix.field.street)[0]!, 'Seestrasse');
    await userEvent.type(field(de.invoice.qrFix.field.number)[0]!, '12');
    await userEvent.type(field(de.invoice.qrFix.field.zip)[0]!, '8001');
    await userEvent.type(field(de.invoice.qrFix.field.town)[0]!, 'Zürich');
    await userEvent.click(screen.getByRole('button', { name: de.invoice.qrFix.saveAndIssue }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const calls = onSave.mock.calls[0]![0] as QrFixCall[];
    expect(calls).toEqual([
      {
        action: 'set_creditor_profile',
        input: { creditorName: 'Beispiel GmbH', address: { street: 'Seestrasse', buildingNo: '12', zip: '8001', town: 'Zürich', country: 'CH' } },
      },
    ]);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a half-filled address saves nothing and issues nothing, and says so', async () => {
    const { onConfirm, onSave } = renderDialog();
    await userEvent.type(field(de.invoice.qrFix.field.street)[0]!, 'Seestrasse');
    await userEvent.click(screen.getByRole('button', { name: de.invoice.qrFix.saveAndIssue }));
    expect(screen.getByRole('alert')).toHaveTextContent(de.invoice.qrFix.incomplete);
    expect(onSave).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a stored country the QR-bill refuses opens the customer block, prefilled, instead of issuing silently (R2-2)', async () => {
    const { onConfirm, onSave } = renderDialog({
      needs: { iban: false, creditorAddress: false, customer: { contactId: 'ct_1', name: 'Muster AG' } },
      customerAddress: { street: 'Musterweg', houseNo: '7', zip: '3000', city: 'Bern', country: 'Schweiz' },
    });
    const country = field(de.invoice.qrFix.field.country);
    expect(country[country.length - 1]).toHaveValue('Schweiz');
    await userEvent.clear(country[country.length - 1]!);
    await userEvent.type(country[country.length - 1]!, 'CH');
    await userEvent.click(screen.getByRole('button', { name: de.invoice.qrFix.saveAndIssue }));
    expect((onSave.mock.calls[0]![0] as QrFixCall[]).map((c) => c.action)).toEqual(['update_contact']);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a refused save issues nothing and names the refusal', async () => {
    const { onConfirm, onSave } = renderDialog({
      needs: { iban: true, creditorAddress: false, customer: null },
      onSave: async () => ({ ok: false, error: 'invalid_iban' }),
    });
    // A structurally valid IBAN the engine still refuses (the engine is the judge, not the form).
    await userEvent.type(screen.getByRole('textbox', { name: de.invoice.qrFix.field.iban }), 'CH9300762011623852957');
    await userEvent.click(screen.getByRole('button', { name: de.invoice.qrFix.saveAndIssue }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(de.invoice.qrFix.invalidIban);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // The engine now refuses what the QR-bill would refuse, where it is typed (critic phase0-installable
  // r1, P0.4e-6/7). Each new code gets its own sentence, never the generic "could not be saved".
  it.each([
    ['iban_not_ch_li', de.invoice.qrFix.ibanNotChLi],
    ['invalid_country', de.invoice.qrFix.invalidCountry],
    ['field_too_long', de.invoice.qrFix.fieldTooLong],
  ])('a %s refusal issues nothing and names the rule it broke', async (code, sentence) => {
    const { onConfirm } = renderDialog({
      needs: { iban: true, creditorAddress: false, customer: null },
      onSave: async () => ({ ok: false, error: code }),
    });
    await userEvent.type(screen.getByRole('textbox', { name: de.invoice.qrFix.field.iban }), 'DE89370400440532013000');
    await userEvent.click(screen.getByRole('button', { name: de.invoice.qrFix.saveAndIssue }));
    expect(screen.getByRole('alert')).toHaveTextContent(sentence);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
