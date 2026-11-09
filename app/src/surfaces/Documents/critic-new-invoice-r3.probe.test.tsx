/**
 * The non-author critic's round-3 probe (written at c8180338), FLIPPED, and the tests of the line date
 * model: "Datum unless stated" (owner) with provenance by STRUCTURE (D164). The Datum is the document's
 * own `supplyDate`, written only when a person states it; a line carries a date only when it was stated
 * for that line, and every stored line date is shown as stated with "auf Datum setzen". Nothing infers
 * a date's origin from its value. See `effectiveSupplyDate` in model.ts and `lineSupplyDate` in the
 * engine.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const TAX_CODES = [{ code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%', active: true }];
const TODAY = new Date().toISOString().slice(0, 10);

/** computeLineTax as the engine runs it: the supply date's ERA decides the normal rate (7.7% before 2024). */
function rateFor(supplyDate: unknown): number {
  return String(supplyDate) < '2024-01-01' ? 770 : 810;
}
function eraPreview(input: Record<string, unknown>): RestResponse {
  const net = Number(input.amountMinor);
  const rateBp = rateFor(input.supplyDate);
  const tax = Math.round((net * rateBp) / 10000);
  return ok({ kind: 'output', netMinor: net, taxMinor: tax, grossMinor: net + tax, rateBp, deductible: false, formLine: '303', trace: { taxCode: 'UST81', taxBaseMinor: net, taxAmountMinor: tax } });
}

interface StoredDoc {
  document: Record<string, unknown>;
  lines: StoredLine[];
  history?: unknown[];
}

interface StoredLine {
  description: string;
  quantityMilli: number;
  unitPriceMinor: number;
  taxCode: string | null;
  supplyDate?: string | null;
}

/**
 * An engine-faithful document store: get_document by id, update_document REPLACES the lines with what
 * was sent (an absent supplyDate is stored as none, `writeLines`), and issue_invoice posts each line
 * at `supply_date ?? issue date` (today), the way buildInvoicePosting and A02 price it.
 */
function engine(docs: Record<string, StoredDoc>) {
  const previews: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  let postedTotal: number | null = null;
  const canned: Canned = {
    list_contacts: ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] }),
    vat_codes: ok({ taxCodes: TAX_CODES }),
    list_documents: ok({ documents: [] }),
    get_contact: ok({ contact: { id: 'ct_1', name: 'Muster AG' } }),
    vat_preview: (input) => {
      previews.push(input);
      return eraPreview(input);
    },
    get_document: (input) => {
      const d = docs[String(input.documentId)];
      if (d === undefined) return { status: 404, body: { ok: false, error: 'not_found' } };
      return ok({ document: d.document, lines: d.lines, history: d.history ?? [] });
    },
    update_document: (input) => {
      updates.push(input);
      const d = docs[String(input.documentId)];
      const patch = input.patch as { lines?: StoredLine[]; supplyDate?: string | null };
      if (d !== undefined && patch.lines !== undefined) d.lines = patch.lines.map((l) => ({ ...l, supplyDate: l.supplyDate ?? null }));
      if (d !== undefined && patch.supplyDate !== undefined) d.document = { ...d.document, supplyDate: patch.supplyDate };
      return ok({ document: d?.document ?? {} });
    },
    issue_invoice: (input) => {
      // lineSupplyDate: the line's date, else the document's, else the issue date (today).
      const d = docs[String(input.invoiceId)];
      const documentDate = (d?.document.supplyDate as string | null | undefined) ?? null;
      postedTotal = (d?.lines ?? []).reduce((sum, l) => {
        const net = Math.round((l.quantityMilli * l.unitPriceMinor) / 1000);
        return sum + net + Math.round((net * rateFor(l.supplyDate ?? documentDate ?? TODAY)) / 10000);
      }, 0);
      return ok({ document: { ...(d?.document ?? {}), status: 'issued', number: 'R-2026-0001' } });
    },
  };
  const transport: Transport = async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return { transport, previews, updates, postedTotal: () => postedTotal };
}

function renderAt(transport: Transport, initial: string) {
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

const invoiceDoc = (overrides: Record<string, unknown> = {}) => ({
  id: 'doc_inv',
  type: 'invoice',
  status: 'draft',
  contactId: 'ct_1',
  currency: 'CHF',
  notes: null,
  dueDate: null,
  sourceDocumentId: null,
  creditedDocumentId: null,
  issueDate: null,
  supplyDate: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  ...overrides,
});

const line = (supplyDate: string | null, description = 'Beratung'): StoredLine => ({
  description,
  quantityMilli: 1000,
  unitPriceMinor: 100000,
  taxCode: 'UST81',
  supplyDate,
});

const updatedLines = (e: ReturnType<typeof engine>, i = 0) =>
  (e.updates[i] as { patch: { lines: Record<string, unknown>[] } }).patch.lines;

const updatedPatch = (e: ReturnType<typeof engine>, i = 0) => (e.updates[i] as { patch: Record<string, unknown> }).patch;

describe('R3 PROBE, flipped: a converted invoice whose line carries the Offerte\'s 20.11.2023 can follow the Datum', () => {
  it('the copied date is shown as stated, "auf Datum setzen" releases it, and the Datum 15.01.2024 is saved on the document', async () => {
    const e = engine({
      // convertDocument cloned `supply_date` onto the invoice draft (the old editor stamped the Offerte).
      doc_inv: {
        document: invoiceDoc({ sourceDocumentId: 'doc_quote', createdAt: '2024-01-10T08:00:00.000Z' }),
        lines: [line('2023-11-20', 'Umbau (Januar 2024 geleistet)')],
      },
    });
    renderAt(e.transport, '/documents/doc_inv');
    // Stored on the line, so a statement by structure: shown, priced at, never dropped silently.
    expect(await screen.findByText(/^Leistungsdatum 20\.11\.2023/)).toBeInTheDocument();
    await waitFor(() => expect(e.previews.at(-1)?.supplyDate).toBe('2023-11-20'));

    // The control the critic found missing: the person releases the line to the Datum, then states it.
    await userEvent.click(screen.getByRole('button', { name: 'Position 1 auf Datum setzen' }));
    expect(screen.queryByText(/Leistungsdatum/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2024-01-15' } });
    await waitFor(() => expect(e.previews.at(-1)?.supplyDate).toBe('2024-01-15'));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(e.updates).toHaveLength(1));
    // The Datum is the DOCUMENT's Leistungsdatum; the line carries no date of its own any more.
    expect(updatedPatch(e).supplyDate).toBe('2024-01-15');
    expect(updatedLines(e)[0]).not.toHaveProperty('supplyDate');
  });
});

describe('"Datum unless stated", provenance by structure (D164)', () => {
  it('a line date the old editor stamped is shown as stated, kept on save, never dropped silently', async () => {
    // 2026-09-01 is also the draft's creation day: no value test decides anything any more.
    const e = engine({ doc_inv: { document: invoiceDoc(), lines: [line('2026-09-01')] } });
    renderAt(e.transport, '/documents/doc_inv');
    expect(await screen.findByText(/^Leistungsdatum 01\.09\.2026/)).toBeInTheDocument();
    await waitFor(() => expect(e.previews.at(-1)?.supplyDate).toBe('2026-09-01'));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(e.updates).toHaveLength(1));
    expect(updatedLines(e)[0]?.supplyDate).toBe('2026-09-01');
    // The Datum was not touched: the document carries no date (null clears nothing that was set).
    expect(updatedPatch(e).supplyDate).toBeNull();
  });

  it('a date an agent stated stays pinned when the Datum moves, and "auf Datum setzen" releases it to the Datum', async () => {
    const e = engine({ doc_inv: { document: invoiceDoc(), lines: [line('2023-06-01')] } });
    renderAt(e.transport, '/documents/doc_inv');
    expect(await screen.findByText(/^Leistungsdatum 01\.06\.2023/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2026-02-02' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(e.previews.at(-1)?.supplyDate).toBe('2023-06-01');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(e.updates).toHaveLength(1));
    expect(updatedLines(e)[0]?.supplyDate).toBe('2023-06-01');
    expect(updatedPatch(e).supplyDate).toBe('2026-02-02');

    await userEvent.click(screen.getByRole('button', { name: 'Position 1 auf Datum setzen' }));
    await waitFor(() => expect(e.previews.at(-1)?.supplyDate).toBe('2026-02-02'));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(e.updates).toHaveLength(2));
    expect(updatedLines(e, 1)[0]).not.toHaveProperty('supplyDate');
    expect(updatedPatch(e, 1).supplyDate).toBe('2026-02-02');
  });

  it('a stored document date loads as the Datum, stated, and stays on save', async () => {
    const e = engine({ doc_inv: { document: invoiceDoc({ supplyDate: '2023-12-28' }), lines: [line(null)] } });
    renderAt(e.transport, '/documents/doc_inv');
    await waitFor(() => expect(screen.getByLabelText('Datum')).toHaveValue('2023-12-28'));
    await waitFor(() => expect(e.previews.at(-1)?.supplyDate).toBe('2023-12-28'));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(e.updates).toHaveLength(1));
    expect(updatedPatch(e).supplyDate).toBe('2023-12-28');
    expect(updatedLines(e)[0]).not.toHaveProperty('supplyDate');
  });

  it('a mixed document: own dates stay on their lines, the stated Datum goes on the document, no line gets it', async () => {
    const e = engine({ doc_inv: { document: invoiceDoc(), lines: [line('2023-06-01', 'A'), line('2026-09-01', 'B'), line(null, 'C')] } });
    renderAt(e.transport, '/documents/doc_inv');
    expect(await screen.findAllByText(/^Leistungsdatum /)).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2026-02-02' } });
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(e.updates).toHaveLength(1));
    expect(updatedLines(e).map((l) => l.supplyDate ?? null)).toEqual(['2023-06-01', '2026-09-01', null]);
    expect(updatedPatch(e).supplyDate).toBe('2026-02-02');
  });

  it('the confirm states exactly what the engine posts, for a mixed document with an untouched Datum', async () => {
    const e = engine({ doc_inv: { document: invoiceDoc(), lines: [line('2023-06-01', 'A'), line('2026-09-01', 'B'), line(null, 'C')] } });
    renderAt(e.transport, '/documents/doc_inv');
    // 1000 at 7.7% (2023) + 1000 at 8.1% (2026-09-01) + 1000 at 8.1% (today) = 3'239.00.
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("CHF 3'239.00"));
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).getByText("Eine Buchung über CHF 3'239.00 wird erstellt.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(e.postedTotal()).toBe(323900));
  });

  it('the confirm states what the engine posts when the person stated a 2023 Datum (carried on the document)', async () => {
    const e = engine({ doc_inv: { document: invoiceDoc(), lines: [line(null, 'A')] } });
    renderAt(e.transport, '/documents/doc_inv');
    await screen.findByLabelText('Bezeichnung 1');
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2023-06-01' } });
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("CHF 1'077.00"));
    await userEvent.click(screen.getByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rechnung ausstellen' });
    expect(within(dialog).getByText("Eine Buchung über CHF 1'077.00 wird erstellt.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    await waitFor(() => expect(e.postedTotal()).toBe(107700));
    expect(updatedLines(e)[0]).not.toHaveProperty('supplyDate');
  });

  it('a derived Gutschrift\'s pinned date stays pinned and read-only', async () => {
    const e = engine({
      doc_cn: {
        document: invoiceDoc({ id: 'doc_cn', type: 'credit_note', creditedDocumentId: 'doc_inv', createdAt: '2026-09-01T10:00:00.000Z' }),
        lines: [{ ...line('2026-09-01'), creditedLinePosition: 1 } as StoredLine],
      },
    });
    renderAt(e.transport, '/documents/doc_cn');
    expect(await screen.findByText('Leistungsdatum 01.09.2026')).toBeInTheDocument();
    await waitFor(() => expect(e.previews.at(-1)?.supplyDate).toBe('2026-09-01'));
    expect(screen.queryByRole('button', { name: /auf Datum setzen/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bezeichnung 1')).not.toBeInTheDocument();
  });

  it('a new invoice with an untouched Datum sends no date at all, on the lines or the document', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ document: { id: 'doc_new', type: 'invoice', status: 'draft' } }));
    const e = engine({});
    const transport: Transport = async (action, input) =>
      action === 'create_document' ? createSpy(input) : e.transport(action, input);
    renderAt(transport, '/documents/new-invoice');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const sent = createSpy.mock.calls[0]?.[0] as { lines: Record<string, unknown>[] };
    expect(sent).not.toHaveProperty('supplyDate');
    expect(sent.lines[0]).not.toHaveProperty('supplyDate');
  });
});
