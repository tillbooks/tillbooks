/**
 * The non-author critic's round-2 probes for Neue Rechnung (written at 49158ee0), FLIPPED: each first
 * reproduced a defect (R2-1, R2-2), and each now asserts the fix on the same repro. R2-3 and the
 * per-line Leistungsdatum of an ordinary invoice draft are added beside them.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';

type CannedHandler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | CannedHandler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function renderAt(canned: Canned, initial: string) {
  const transport: Transport = async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return render(
    <TillClientProvider client={new TillClient(transport)}>
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

/** computeLineTax as the engine runs it: the supply date's ERA decides the normal rate (7.7% before 2024). */
function eraPreview(input: Record<string, unknown>): RestResponse {
  const net = Number(input.amountMinor);
  const rateBp = String(input.supplyDate) < '2024-01-01' ? 770 : 810;
  const tax = Math.round((net * rateBp) / 10000);
  return ok({ kind: 'output', netMinor: net, taxMinor: tax, grossMinor: net + tax, rateBp, deductible: false, formLine: '303', trace: { taxCode: 'UST81', taxBaseMinor: net, taxAmountMinor: tax } });
}

describe('R2 PROBE A (R2-1): a line is previewed at its OWN supply date, the one the engine posts at', () => {
  const draft = {
    document: { id: 'doc_cn', type: 'credit_note', status: 'draft', contactId: 'ct_1', currency: 'CHF', notes: null, dueDate: null, sourceDocumentId: null, creditedDocumentId: 'doc_inv' },
    // As get_document sends it: createCreditNote pinned the credited invoice's supply date.
    lines: [{ description: 'Beratung 2023', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-06-01', creditedLinePosition: 1 }],
    history: [],
  };

  it('a derived Gutschrift of a 2023 invoice: the preview asks at 2023-06-01 and the confirm states the CHF 1077.00 posted', async () => {
    const previews: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const issueSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_cn', type: 'credit_note', status: 'issued', number: 'G-2026-0001' } }));
    renderAt(
      {
        list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
        vat_codes: ok({ taxCodes: TAX_CODES }),
        list_documents: ok({ documents: [] }),
        vat_preview: (input) => {
          previews.push(input);
          return eraPreview(input);
        },
        get_document: ok(draft),
        update_document: (input) => {
          updates.push(input);
          return ok(draft);
        },
        issue_credit_note: issueSpy,
      },
      '/documents/doc_cn',
    );
    await waitFor(() => expect(previews.length).toBeGreaterThan(0));
    // Every preview of the line is at its pinned 2023-06-01, never at the editor's "Datum".
    expect(previews.every((p) => p.supplyDate === '2023-06-01')).toBe(true);
    // Pinned by createCreditNote: shown, and nothing offers to change it.
    expect(screen.getByText('Leistungsdatum 01.06.2023')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /auf Datum setzen/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog');
    // Engine fact (critic engine probe): issue_credit_note posts tax 7700, total 107700 for this line.
    expect(within(dialog).getByText(/Eine Buchung über CHF 1.077.00 wird erstellt/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/1.081.00/)).not.toBeInTheDocument();
    // The derived Gutschrift patches only notes and the due date: its lines are never re-dated.
    expect(updates[0]).not.toHaveProperty('patch.lines');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
  });

  it('an invoice draft whose line carries its own Leistungsdatum keeps it: previewed, shown and saved at that date', async () => {
    const previews: Record<string, unknown>[] = [];
    const updateSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_inv', type: 'invoice', status: 'draft' } }));
    const invoiceDraft = {
      document: { id: 'doc_inv', type: 'invoice', status: 'draft', contactId: 'ct_1', currency: 'CHF', notes: null, dueDate: null, sourceDocumentId: null },
      // Two positions an agent drafted: one with its own 2023 Leistungsdatum, one without.
      lines: [
        { description: 'Beratung 2023', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-06-01' },
        { description: 'Beratung heute', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: null },
      ],
      history: [],
    };
    renderAt(
      {
        list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
        vat_codes: ok({ taxCodes: TAX_CODES }),
        list_documents: ok({ documents: [] }),
        vat_preview: (input) => {
          previews.push(input);
          return eraPreview(input);
        },
        get_document: ok(invoiceDraft),
        get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG' } }),
        update_document: updateSpy,
      },
      '/documents/doc_inv',
    );
    await waitFor(() => expect(previews.length).toBe(2));
    expect(previews.map((p) => p.supplyDate).sort()).toEqual(['2023-06-01', new Date().toISOString().slice(0, 10)].sort());
    // The stated date is said on its line; the other line follows "Datum" and says nothing.
    expect(screen.getByText(/^Leistungsdatum 01\.06\.2023/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Leistungsdatum /)).toHaveLength(1);
    // 7.7% on line 1, 8.1% on line 2: the Total is the two answers, CHF 2158.00.
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("CHF 2'158.00"));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    const lines = (updateSpy.mock.calls[0]?.[0] as { patch: { lines: { supplyDate: string }[] } }).patch.lines;
    expect(lines[0]?.supplyDate).toBe('2023-06-01');
    // "Datum unless stated": the undated line follows the untouched Datum, and nothing is stamped.
    expect(lines[1]).not.toHaveProperty('supplyDate');
  });
});

describe('R2 PROBE B (R2-2): a member who may issue but may not read VAT issues, and no figure is stated', () => {
  it('vat_preview answers permission_denied (read_vat): no summary, no Total, a confirm without an amount, and issue_invoice runs', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', type: 'invoice', status: 'draft' } }));
    const issueSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_1', type: 'invoice', status: 'issued', number: 'R-2026-0001' } }));
    let previews = 0;
    renderAt(
      {
        list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
        vat_codes: ok({ taxCodes: TAX_CODES }),
        list_documents: ok({ documents: [] }),
        vat_preview: () => {
          previews += 1;
          return { status: 403, body: { ok: false, error: 'permission_denied', capability: 'read_vat' } };
        },
        create_document: createSpy,
        issue_invoice: issueSpy,
      },
      '/documents/new-invoice',
    );
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await waitFor(() => expect(previews).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));

    // No tax, no Total, no "wird berechnet" that would never resolve, and no error on the line.
    expect(screen.queryByLabelText('MWST-Übersicht')).not.toBeInTheDocument();
    expect(screen.queryByText('Keine MWST auf diesem Beleg')).not.toBeInTheDocument();
    const totals = document.querySelector('.documents-editor-totals') as HTMLElement;
    expect(within(totals).queryByText('Total')).not.toBeInTheDocument();
    expect(within(totals).queryByText('wird berechnet')).not.toBeInTheDocument();
    expect(screen.queryByText(/MWST CHF|Brutto CHF/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Code archiviert|nicht berechnen/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).getByText('Eine Buchung wird erstellt, die Beträge rechnet TILL beim Ausstellen.')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/CHF/);
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledOnce());
    // The denial is not retried in a loop: it is an answer, not a lost one.
    expect(previews).toBe(1);
  });
});

describe('R2-3: the VAT gates bind only what POSTS', () => {
  it('a quote whose line preview the engine refuses still issues: it posts nothing and states no figure', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_q', type: 'quote', status: 'draft' } }));
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_q', status: 'issued' } }));
    renderAt(
      {
        list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
        vat_codes: ok({ taxCodes: TAX_CODES }),
        list_documents: ok({ documents: [] }),
        vat_preview: { status: 422, body: { ok: false, error: 'rate_era_unknown' } },
        create_document: createSpy,
        transition_document: transitionSpy,
      },
      '/documents/new?type=quote',
    );
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await new Promise((r) => setTimeout(r, 30));
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    expect(screen.queryByText(/lässt sich die MWST nicht berechnen|wird noch berechnet/)).not.toBeInTheDocument();
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg ausstellen' });
    expect(dialog.textContent).not.toMatch(/CHF/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
  });

  it('an order whose preview answer is lost still issues', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_o', type: 'order', status: 'draft' } }));
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_o', status: 'issued' } }));
    renderAt(
      {
        list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
        vat_codes: ok({ taxCodes: TAX_CODES }),
        list_documents: ok({ documents: [] }),
        vat_preview: { status: 0, body: { ok: false, error: 'transport_error' } },
        create_document: createSpy,
        transition_document: transitionSpy,
      },
      '/documents/new?type=order',
    );
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await waitFor(() => expect(screen.getByLabelText('MWST 1')).toHaveTextContent(/UST81$/));
    await userEvent.click(screen.getByLabelText('Einzelpreis 1'));
    await userEvent.paste('150');
    await new Promise((r) => setTimeout(r, 30));
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Beleg ausstellen' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ausstellen' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
  });
});
