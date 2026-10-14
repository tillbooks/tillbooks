/**
 * The non-author critic's probes for the Neue Rechnung branch (written at eb7e7f75), FLIPPED: each
 * one first reproduced a defect (F1 to F4), and each now asserts the fix on the same repro.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';
import issueFixture from './issue-invoice.fixture.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const lost = (): RestResponse => ({ status: 0, body: { ok: false, error: 'transport_error', detail: 'lost' } });

function transportOf(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

function renderAt(canned: Canned, initial = '/documents/new') {
  return render(
    <TillClientProvider client={new TillClient(transportOf(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={[initial]}>
            <Routes>
              <Route path="/documents/*" element={<DocumentsSurface />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const TAX_CODES = [{ code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%', active: true }];

/** An engine-faithful preview: 8.1% of the net, rounded, exactly what computeLineTax answers. */
function preview(input: Record<string, unknown>): RestResponse {
  const net = Number(input.amountMinor);
  const tax = Math.round((net * 810) / 10000);
  return ok({
    kind: 'output',
    netMinor: net,
    taxMinor: tax,
    grossMinor: net + tax,
    rateBp: 810,
    deductible: false,
    formLine: '303',
    trace: { taxCode: 'UST81', taxBaseMinor: net, taxAmountMinor: tax },
  });
}

const base = (contacts: unknown[] = [{ id: 'ct_1', name: 'Muster AG' }]): Canned => ({
  list_contacts: ok({ contacts }),
  vat_codes: ok({ taxCodes: TAX_CODES }),
  list_documents: ok({ documents: [] }),
  vat_preview: preview,
});

async function pickCustomer(name = 'Muster AG') {
  await userEvent.click(await screen.findByLabelText('Kunde'));
  await userEvent.click(screen.getByRole('option', { name }));
}

async function pickTaxCode(trigger: HTMLElement, code: string) {
  await userEvent.click(trigger);
  const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === code);
  if (option === undefined) throw new Error(`no ${code}`);
  await userEvent.click(option);
}

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('PROBE 1 (F2): a lost vat_preview never reaches the Total or the issue confirm', () => {
  it('the Total waits, the press re-asks the lost preview, and the confirm states the CHF 162.15 the engine posts', async () => {
    let previews = 0;
    let answerRetry: () => void = () => undefined;
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    renderAt({
      ...base(),
      // The FIRST answer for this line is lost on the wire; asked again, the engine answers (held
      // until the test lets it, so the refusal line can be read while the retry is out).
      vat_preview: async (input) => {
        previews += 1;
        if (previews === 1) return lost();
        await new Promise<void>((r) => (answerRetry = r));
        return preview(input);
      },
      create_document: ok({ document: { id: 'doc_1', type: 'invoice', status: 'draft' } }),
      issue_invoice: issueSpy,
    });
    await pickCustomer();
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await waitFor(() => expect(previews).toBe(1));
    await new Promise((r) => setTimeout(r, 30));

    // No summary, and the Total states no figure that lacks the tax.
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();
    const totals = document.querySelector('.documents-editor-totals') as HTMLElement;
    expect(within(totals).getAllByText('CHF 150.00')).toHaveLength(1);
    expect(within(totals).getByText('wird berechnet')).toBeInTheDocument();

    // The press refuses in one line and asks the lost preview again; nothing is saved or opened.
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    expect(await screen.findByText('Die MWST wird noch berechnet. Drück gleich noch einmal.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(previews).toBe(2));
    expect(within(totals).getByText('wird berechnet')).toBeInTheDocument();
    answerRetry();
    await waitFor(() => expect(within(totals).getByText('CHF 162.15')).toBeInTheDocument());
    expect(within(screen.getByLabelText('MWST-Übersicht')).getAllByText('CHF 12.15').length).toBeGreaterThan(0);
    expect(screen.queryByText('Die MWST wird noch berechnet. Drück gleich noch einmal.')).not.toBeInTheDocument();

    // Settled: the confirm states the figures issue_invoice posts (15000 + 1215 = 16215).
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).getByText('Eine Buchung über CHF 162.15 wird erstellt.')).toBeInTheDocument();
    expect(within(dialog).getByText(/CHF 12.15/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
  });

  it('a preview the engine REFUSES is named by its position, not "still being worked out"', async () => {
    renderAt({ ...base(), vat_preview: { status: 422, body: { ok: false, error: 'rate_era_unknown' } } });
    await pickCustomer();
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await new Promise((r) => setTimeout(r, 30));
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    expect(await screen.findByText('Für Position 1 lässt sich die MWST nicht berechnen.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('PROBE 2 (F4): a line switched to "Keine MWST" drops its tax at once, even while another preview is out', () => {
  it('the summary and the Total carry CHF 8.10, never the stale CHF 20.25, while line 1 is re-asked', async () => {
    const held: (() => void)[] = [];
    let hold = false;
    renderAt({
      ...base(),
      vat_preview: async (input) => {
        if (hold) await new Promise<void>((r) => held.push(r));
        return preview(input);
      },
    });
    await pickCustomer();
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('100');
    await userEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 2')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 2'));
    await userEvent.paste('150');
    const summary = await screen.findByLabelText('MWST-Übersicht');
    await waitFor(() => expect(within(summary).getAllByText('CHF 20.25').length).toBeGreaterThan(0));

    // Line 2 becomes "Keine MWST" while line 1's re-preview is slow.
    hold = true;
    await pickTaxCode(screen.getByLabelText('MWST 2'), '');
    await new Promise((r) => setTimeout(r, 30));
    const current = screen.getByLabelText('MWST-Übersicht');
    expect(within(current).queryByText('CHF 20.25')).not.toBeInTheDocument();
    expect(within(current).getAllByText('CHF 8.10').length).toBeGreaterThan(0);
    const totals = document.querySelector('.documents-editor-totals') as HTMLElement;
    expect(within(totals).queryByText('CHF 270.25')).not.toBeInTheDocument();
    expect(within(totals).getByText('CHF 258.10')).toBeInTheDocument();
    held.splice(0).forEach((r) => r());
    await waitFor(() => expect(within(screen.getByLabelText('MWST-Übersicht')).getAllByText('CHF 8.10').length).toBeGreaterThan(0));
  });
});

describe('PROBE 3 (F1): a type change between a lost create and its retry', () => {
  /** An engine-faithful create: a known key replays the stored draft, whatever the input says. */
  function engineCreate(opts: { storedType?: string } = {}) {
    const stored = new Map<string, RestResponse>();
    let calls = 0;
    const spy = vi.fn<CannedHandler>((input) => {
      calls += 1;
      const key = String(input.idempotencyKey);
      let result = stored.get(key);
      if (result === undefined) {
        result = ok({ document: { id: `doc_${stored.size + 1}`, type: opts.storedType ?? input.type, status: 'draft' } });
        stored.set(key, result);
      }
      return calls === 1 ? lost() : result;
    });
    return spy;
  }

  it('while the lost create is unanswered, Typ is locked, so the retry cannot ask for another type', async () => {
    const createSpy = engineCreate();
    renderAt({ ...base(), create_document: createSpy }, '/documents/new');
    await pickCustomer();
    expect(screen.getByLabelText('Typ')).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Typ')).toBeDisabled());
  });

  it('a replay that hands back another type: the editor adopts the engine\'s type, says so, and issues nothing yet', async () => {
    // The editor says Offerte; the engine already holds an INVOICE under the act's key.
    const createSpy = engineCreate({ storedType: 'invoice' });
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', status: 'draft' } }));
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', status: 'issued' } }));
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    renderAt(
      { ...base(), create_document: createSpy, update_document: updateSpy, transition_document: transitionSpy, issue_invoice: issueSpy },
      '/documents/new?type=quote',
    );
    await pickCustomer();
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    expect(createSpy.mock.calls[1]?.[0].idempotencyKey).toBe(createSpy.mock.calls[0]?.[0].idempotencyKey);
    // One line, before anything else happens: no dialog, no transition, no issue.
    expect(await screen.findByText('Dieser Entwurf war schon als Rechnung gespeichert und bleibt es.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Typ')).toHaveTextContent('Rechnung');

    // The next press is the invoice's own act: the money confirm and issue_invoice, never a quote.
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    const confirm = within(dialog).getByRole('button', { name: /^Ausstellen/ });
    expect(confirm).toHaveAttribute('data-money-commit', 'issue_invoice issue_credit_note');
    await userEvent.click(confirm);
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
    expect(issueSpy.mock.calls[0]?.[0]).toMatchObject({ invoiceId: 'doc_1' });
    expect(transitionSpy).not.toHaveBeenCalled();
  });
});

describe('PROBE 4 (F3): an untouched due date is never stored; the issue derives it', () => {
  it('Save without touching Zahlbar bis sends no dueDate, and the row says what the issue will set', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', type: 'invoice', status: 'draft' } }));
    renderAt({ ...base([{ id: 'ct_1', name: 'Muster AG', paymentTermsDays: 30 }]), create_document: createSpy }, '/documents/new-invoice');
    await pickCustomer();
    expect(screen.getByLabelText('Zahlbar bis')).toHaveValue('');
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription('Ergibt sich beim Ausstellen: 30 Tage ab Rechnungsdatum.');
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0]?.[0]).not.toHaveProperty('dueDate');
  });

  it('a stored date is the person\'s: kept on reopen, and a date already past is said on the confirm', async () => {
    const savedYesterday = isoDaysFromToday(-1);
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', status: 'draft' } }));
    const issueSpy = vi.fn<CannedHandler>(() => ok({ ...issueFixture }));
    renderAt(
      {
        ...base([{ id: 'ct_1', name: 'Muster AG', paymentTermsDays: 0 }]),
        get_document: ok({
          document: { id: 'doc_1', type: 'invoice', status: 'draft', contactId: 'ct_1', currency: 'CHF', notes: null, dueDate: savedYesterday, sourceDocumentId: null },
          lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 15000, taxCode: 'UST81' }],
          history: [],
        }),
        get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG' } }),
        update_document: updateSpy,
        issue_invoice: issueSpy,
      },
      '/documents/doc_1',
    );
    const due = await screen.findByLabelText('Zahlbar bis');
    expect(due).toHaveValue(savedYesterday);
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent('CHF 162.15'));
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0]?.[0]).toMatchObject({ patch: { dueDate: savedYesterday } });
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).getByText(/liegt vor dem heutigen Ausstellungsdatum, die Rechnung ist also sofort überfällig/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
  });

  it('a back-dated "Datum" moves no due date: nothing is sent, and the hint counts from the issue', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', type: 'invoice', status: 'draft' } }));
    renderAt({ ...base([{ id: 'ct_1', name: 'Muster AG', paymentTermsDays: 30 }]), create_document: createSpy }, '/documents/new-invoice');
    await pickCustomer();
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2026-01-02' } });
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const sent = createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('date');
    expect(sent).not.toHaveProperty('dueDate');
    expect(screen.getByLabelText('Zahlbar bis')).toHaveAccessibleDescription(/ab Rechnungsdatum/);
  });
});

import { axe } from 'jest-axe';
import profileFixture from '../Setup/company-profile.fixture.json';

describe('PROBE a11y: the populated Neue Rechnung (terms (i), currency (i), QR heading (i))', () => {
  it('axe, and every (i) trigger is named and described', async () => {
    const { container } = renderAt(
      {
        ...base([{ id: 'ct_1', name: 'Muster AG', paymentTermsDays: 30, address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' } }]),
        get_company_profile: ok({ profile: profileFixture.profile }),
      },
      '/documents/new-invoice',
    );
    await pickCustomer();
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await screen.findByLabelText('QR-Bereitschaft');
    const triggers = Array.from(container.querySelectorAll('.documents-info-trigger'));
    expect(triggers.length).toBeGreaterThanOrEqual(3);
    for (const b of triggers) {
      expect(b).toHaveAccessibleName();
      expect(b).toHaveAccessibleDescription();
    }
    // F6: heading-order is ON. The figures carry their own h2, so the summary's h3 skips no level.
    const results = await axe(container, { rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
