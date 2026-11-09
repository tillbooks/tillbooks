/**
 * Non-author critic, round 5 (D164 at a5fb57cb): the Studio editor driven against the REAL engine
 * (root `dist/`, built with `npx tsc -p tsconfig.json`), sharing one clock with the browser through
 * vitest's fake Date. Every write goes through `handleRest`, the REST twin the Studio bridge uses.
 *
 * Each test states what the confirm said and what the engine posted, and where the model reads a
 * stated date. Adopted by the author for round 5: where a probe recorded a defect (the empty Datum,
 * F3), it now asserts the fixed behaviour, named in its title; the Gutschrift readout (F1) passes as
 * the critic wrote it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// The root engine, loaded by NODE's own require (Node 22 requires ESM), not by vite, whose module
// order breaks an engine import cycle. `dist/` must be built first (`npx tsc -p tsconfig.json`).
const DIST = `${resolve(process.cwd(), '..', 'dist')}/`;
const nodeRequire = createRequire(`${DIST}probe.cjs`);
/* eslint-disable @typescript-eslint/no-explicit-any */
const { SqliteStore } = nodeRequire(`${DIST}core/store/sqlite-store.js`) as Record<string, any>;
const { sequenceIdGen } = nodeRequire(`${DIST}core/ids.js`) as Record<string, any>;
const { getAction } = nodeRequire(`${DIST}api/registry.js`) as Record<string, any>;
const { handleRest } = nodeRequire(`${DIST}api/rest.js`) as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

type Row = Record<string, unknown>;

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso));
}

/** One real engine, one workspace, MWST configured (effektiv, soll), one customer. */
function world() {
  const clock = { now: () => new Date().toISOString() };
  const deps = { store: new SqliteStore({ clock }), clock, ids: sequenceIdGen(), actor: 'user_1' };
  const ws = getAction('create_workspace').run(deps, { name: 'Probe GmbH', idempotencyKey: 'ws' }) as Row;
  const workspaceId = ws.workspaceId as string;
  const run = (verb: string, input: Row) => handleRest(verb, { workspaceId, ...input }, deps) as RestResponse;
  const cfg = run('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'cfg' });
  if (cfg.body.ok !== true) throw new Error(`vat_configure: ${JSON.stringify(cfg.body)}`);
  const contact = run('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'ct' });
  if (contact.body.ok !== true) throw new Error(`create_contact: ${JSON.stringify(contact.body)}`);
  const calls: { verb: string; input: Row; body: Row }[] = [];
  const transport: Transport = async (verb, input) => {
    const res = handleRest(verb, { ...input, workspaceId }, deps) as RestResponse;
    calls.push({ verb, input, body: res.body as Row });
    return res;
  };
  const doc = (id: string) => (run('get_document', { documentId: id }).body as Row);
  const row = (id: string) =>
    deps.store.db.prepare('SELECT status, issue_date, tax_minor, total_minor FROM document WHERE id = ?').get(id) as Row;
  return { deps, workspaceId, run, transport, calls, doc, row, contactId: ((contact.body as Row).contact as Row).id as string };
}

function renderAt(transport: Transport, workspaceId: string, initial: string) {
  return render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Press Ausstellen, read the confirm's posting sentence, confirm, and return the figure it named. */
async function issueThroughConfirm(): Promise<string> {
  await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
  const dialog = await screen.findByRole('alertdialog');
  const said = within(dialog).getByText(/Eine Buchung über/).textContent ?? '';
  await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
  return said;
}


async function newInvoice(w: ReturnType<typeof world>, price = '1000') {
  renderAt(w.transport, w.workspaceId, '/documents/new-invoice');
  await userEvent.click(await screen.findByLabelText('Kunde'));
  await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
  await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Arbeit');
  await userEvent.type(screen.getByLabelText('Einzelpreis 1'), price);
}
const createdId = (w: ReturnType<typeof world>) => ((w.calls.find((c) => c.verb === 'create_document' && c.body.ok === true)!.body.document as Row).id) as string;

describe('R5 engine probe (D164)', () => {
  it('CONFIRM DIALOG OPEN ACROSS MIDNIGHT: opened 31.12 23:58, confirmed 01.01 00:02, untouched Datum', async () => {
    setNow('2023-12-31T23:50:00.000Z');
    const w = world();
    // A 7.7% code: its stored rate IS the 2023 era rate, so on 31.12.2023 nothing is ambiguous.
    w.run('vat_code_upsert', { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'MWST 7.7%', idempotencyKey: 'tc77' });
    w.run('vat_code_deactivate', { code: 'UST81', idempotencyKey: 'off81' });
    await newInvoice(w);
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'077.00"));
    setNow('2023-12-31T23:58:00.000Z');
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog');
    const said = within(dialog).getByText(/Eine Buchung über/).textContent ?? '';
    setNow('2024-01-01T00:02:00.000Z');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    const id = createdId(w);
    await waitFor(() => expect(w.calls.some((c) => c.verb === 'issue_invoice')).toBe(true));
    const answer = w.calls.find((c) => c.verb === 'issue_invoice')!.body;
    // Either the engine posts what the confirm said, or it refuses (fail-closed) and says why.
    if (answer.ok === true) expect(w.row(id).total_minor).toBe(said.includes("1'077.00") ? 107700 : -1);
    else {
      expect(answer.error).toBe('needs_supply_date');
      expect(w.row(id).status).toBe('draft');
      expect(await within(dialog).findByText(/Position 1 mit UST77 braucht ein Leistungsdatum/)).toBeInTheDocument();
    }
  });

  it('a converted Offerte carrying a document Datum opens with that Datum, and the confirm equals the posting', async () => {
    setNow('2024-01-10T09:00:00.000Z');
    const w = world();
    const q = w.run('create_document', { type: 'quote', contactId: w.contactId, currency: 'CHF', supplyDate: '2023-12-20', lines: [{ description: 'Umbau', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81' }], idempotencyKey: 'q' });
    const qid = ((q.body as Row).document as Row).id as string;
    for (const [to, k] of [['issued', 'a'], ['sent', 'b'], ['accepted', 'c']]) w.run('transition_document', { documentId: qid, to, idempotencyKey: k });
    const conv = w.run('convert_document', { documentId: qid, toType: 'invoice', idempotencyKey: 'cv' });
    const id = ((conv.body as Row).document as Row).id as string;
    renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    await waitFor(() => expect(screen.getByLabelText('Datum')).toHaveValue('2023-12-20'));
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'077.00"));
    const said = await issueThroughConfirm();
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect(said).toContain("1'077.00");
    expect(w.row(id).total_minor).toBe(107700);
  });

  it('a Datum cleared to empty (F3, flipped): Ausstellen names the missing Datum in one line, never a confirm or a code error', async () => {
    setNow('2024-01-10T09:00:00.000Z');
    const w = world();
    await newInvoice(w);
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'081.00"));
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '' } });
    // No preview is asked for an undated line, so no line reads as a code problem.
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent('wird berechnet'));
    expect(screen.queryByText(/Code archiviert|Unbekannter MWST-Code/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    expect(await screen.findByText('Das Datum fehlt: setz das Datum der Leistung.')).toBeInTheDocument();
    // Fail-closed: no write, no confirm.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(w.calls.filter((c) => c.verb === 'create_document')).toEqual([]);
  });
});

describe('R5 engine probe: the Gutschrift dialog on an invoice dated by its document Datum', () => {
  it('CREDIT GROSS READOUT: the amount arm states the gross the engine posts (document date 20.12.2023, issued 10.01.2024)', async () => {
    setNow('2024-01-10T09:00:00.000Z');
    const w = world();
    const inv = w.run('create_document', {
      type: 'invoice', contactId: w.contactId, currency: 'CHF', supplyDate: '2023-12-20',
      lines: [{ description: 'Umbau Dezember', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'inv',
    });
    const invId = ((inv.body as Row).document as Row).id as string;
    const issued = w.run('issue_invoice', { invoiceId: invId, idempotencyKey: 'ii' });
    expect((issued.body as Row).ok).toBe(true);
    expect(w.row(invId).total_minor).toBe(107700);

    renderAt(w.transport, w.workspaceId, `/documents/${invId}`);
    // The detail itself states 7.7% (DocumentDetail is on the one rule).
    await waitFor(() => expect(document.querySelector('[data-vat-state="settled"]')).not.toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: 'Gutschrift erstellen' }));
    await userEvent.click(await screen.findByLabelText('Ein Betrag (netto)'));
    await userEvent.type(screen.getByLabelText(/Betrag in CHF \(netto\)/), '500');
    const readout = (await screen.findByText(/Ergibt brutto/)).textContent ?? '';
    // What the engine credits for the same 500.00 net.
    const cn = w.run('create_credit_note', { fromInvoiceId: invId, mode: 'partial', amountMinor: 50000, idempotencyKey: 'cn' });
    const cnId = ((cn.body as Row).document as Row).id as string;
    expect(((w.run('issue_credit_note', { creditNoteId: cnId, idempotencyKey: 'ic' }).body) as Row).ok).toBe(true);
    const posted = w.row(cnId).total_minor as number;
    expect({ readout, posted }).toEqual({ readout: "Ergibt brutto (inkl. MWST): CHF 538.50", posted: 53850 });
  });
});
