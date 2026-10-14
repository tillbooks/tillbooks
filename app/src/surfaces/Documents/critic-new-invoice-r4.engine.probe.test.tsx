/**
 * Non-author critic, round 4 (redesign at 40a85905): the Studio editor driven against the REAL engine
 * (root `dist/`, built with `npx tsc -p tsconfig.json`), sharing one clock with the browser through
 * vitest's fake Date. Every write goes through `handleRest`, the REST twin the Studio bridge uses.
 *
 * Each test states what the confirm said and what the engine posted, and where the model reads a
 * stated date. Adopted by the author for D164 (provenance by structure) and made to pass: where a probe
 * recorded the round-4 defect, it now asserts the fixed behaviour, and each such change is named.
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
import { axe } from 'jest-axe';
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

const lastLines = (w: ReturnType<typeof world>, id: string) => (w.doc(id).lines as Row[]).map((l) => l.supplyDate);
/** D164: the document-level Leistungsdatum the engine holds (the Studio's stated Datum). */
const documentDate = (w: ReturnType<typeof world>, id: string) => (w.doc(id).document as Row).supplyDate;

describe('R4 engine probe: the confirm equals what the engine posts', () => {
  it('a new invoice with an untouched Datum, saved, then issued two days later', async () => {
    setNow('2026-09-30T09:00:00.000Z');
    const w = world();
    renderAt(w.transport, w.workspaceId, '/documents/new-invoice');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Beratung');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '1000');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(w.calls.some((c) => c.verb === 'create_document' && c.body.ok === true)).toBe(true));
    const id = ((w.calls.find((c) => c.verb === 'create_document')!.body.document as Row).id) as string;
    cleanup();

    setNow('2026-10-02T09:00:00.000Z');
    renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    await screen.findByLabelText('Bezeichnung 1');
    const said = await issueThroughConfirm();
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect(said).toContain("1'081.00");
    expect(w.row(id)).toMatchObject({ issue_date: '2026-10-02', total_minor: 108100 });
  });

  it('STATED DATUM KEPT (was LOST): a Datum the person set is the document\'s Leistungsdatum, survives reopen, and the invoice posts at its era', async () => {
    // 28.12.2023: the work is finished and the draft is started (Datum untouched, today).
    setNow('2023-12-28T15:00:00.000Z');
    const w = world();
    renderAt(w.transport, w.workspaceId, '/documents/new-invoice');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Umbau Dezember');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '1000');
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(w.calls.some((c) => c.verb === 'create_document' && c.body.ok === true)).toBe(true));
    const id = ((w.calls.find((c) => c.verb === 'create_document')!.body.document as Row).id) as string;
    cleanup();

    // 03.01.2024: reopened, the Datum shows today. The person states the Leistungsdatum: 28.12.2023.
    setNow('2024-01-03T09:00:00.000Z');
    renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    await screen.findByLabelText('Bezeichnung 1');
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2023-12-28' } });
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'077.00"));
    await userEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    // D164: the Datum is stored on the DOCUMENT, by structure; no line is stamped with it.
    await waitFor(() => expect(documentDate(w, id)).toBe('2023-12-28'));
    expect(lastLines(w, id)).toEqual([null]);
    cleanup();

    // 04.01.2024: reopened to issue. The stated 28.12.2023 is the Datum again (it is createdAt's day,
    // which no longer matters: nothing reads a date's value to decide where it came from).
    setNow('2024-01-04T09:00:00.000Z');
    renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    await screen.findByLabelText('Bezeichnung 1');
    await waitFor(() => expect(screen.getByLabelText('Datum')).toHaveValue('2023-12-28'));
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'077.00"));
    const said = await issueThroughConfirm();
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    const posted = w.row(id);
    expect(said).toContain("1'077.00");
    expect({ documentDate: documentDate(w, id), supplyDates: lastLines(w, id), total: posted.total_minor }).toEqual({
      documentDate: '2023-12-28',
      supplyDates: [null],
      total: 107700,
    });
  });

  it('STATED DATE KEPT (was LOST): an agent drafts with a stated Leistungsdatum of today; issued in Studio after the era change, it posts at that era', async () => {
    setNow('2023-12-29T10:00:00.000Z');
    const w = world();
    const created = w.run('create_document', {
      type: 'invoice',
      contactId: w.contactId,
      currency: 'CHF',
      lines: [{ description: 'Montage 29.12.', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-12-29' }],
      idempotencyKey: 'agent-draft',
    });
    expect(created.body.ok).toBe(true);
    const id = ((created.body as Row).document as Row).id as string;

    setNow('2024-01-05T09:00:00.000Z');
    renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    await screen.findByLabelText('Bezeichnung 1');
    const shownStated = screen.queryByText(/Leistungsdatum 29\.12\.2023/) !== null;
    await issueThroughConfirm();
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect({ shownStated, supplyDates: lastLines(w, id), total: w.row(id).total_minor }).toEqual({
      shownStated: true,
      supplyDates: ['2023-12-29'],
      total: 107700,
    });
  });

  it('a Datum set to the past, issued in the same session: confirm == posted', async () => {
    setNow('2024-01-04T09:00:00.000Z');
    const w = world();
    renderAt(w.transport, w.workspaceId, '/documents/new-invoice');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Umbau');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '1000');
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2023-12-20' } });
    const said = await issueThroughConfirm();
    const id = ((w.calls.find((c) => c.verb === 'create_document')!.body.document as Row).id) as string;
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect(said).toContain("1'077.00");
    expect(w.row(id).total_minor).toBe(107700);
  });

  it('a Datum changed then reset to today: the reset is a stated today, confirm == posted', async () => {
    setNow('2024-01-04T09:00:00.000Z');
    const w = world();
    renderAt(w.transport, w.workspaceId, '/documents/new-invoice');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Umbau');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '1000');
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2023-12-20' } });
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2024-01-04' } });
    const said = await issueThroughConfirm();
    const id = ((w.calls.find((c) => c.verb === 'create_document')!.body.document as Row).id) as string;
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect(said).toContain("1'081.00");
    expect(w.row(id).total_minor).toBe(108100);
  });
  it('CONFIRM == POSTED (was !=): an editor opened on 31.12 with an untouched Datum, pressed after midnight, re-prices at 01.01 before any confirm', async () => {
    setNow('2023-12-31T21:00:00.000Z');
    const w = world();
    renderAt(w.transport, w.workspaceId, '/documents/new-invoice');
    await userEvent.click(await screen.findByLabelText('Kunde'));
    await userEvent.click(screen.getByRole('option', { name: 'Muster AG' }));
    await userEvent.type(screen.getByLabelText('Bezeichnung 1'), 'Silvesterdienst');
    await userEvent.type(screen.getByLabelText('Einzelpreis 1'), '1000');
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'077.00"));
    // The tab stays open; the person presses Ausstellen the next morning.
    setNow('2024-01-01T08:00:00.000Z');
    // F2: the first press moves the untouched Datum to today, re-prices, says so, and opens nothing.
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    expect(await screen.findByText(/Es ist jetzt der 01\.01\.2024/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(w.calls.some((c) => c.verb === 'create_document')).toBe(false);
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'081.00"));
    // The next press confirms the figure the engine posts on 01.01.2024: 8.1%.
    const said = await issueThroughConfirm();
    const id = ((w.calls.find((c) => c.verb === 'create_document')!.body.document as Row).id) as string;
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect({ said: said.includes("1'081.00") ? 108100 : said, posted: w.row(id).total_minor }).toEqual({ said: 108100, posted: 108100 });
    // An untouched Datum is still not stored: the engine used its own issue date.
    expect(documentDate(w, id)).toBeNull();
  });

  it('HISTORIC CODE (was a generic refusal): a workspace UST77 with an untouched Datum is refused before the confirm, naming the position; stating the Datum issues it', async () => {
    setNow('2026-10-04T09:00:00.000Z');
    const w = world();
    const up = w.run('vat_code_upsert', { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'MWST 7.7% (bis 2023)', idempotencyKey: 'tc77' });
    expect(up.body.ok).toBe(true);
    const created = w.run('create_document', {
      type: 'invoice', contactId: w.contactId, currency: 'CHF',
      lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST77' }],
      idempotencyKey: 'd77',
    });
    const id = ((created.body as Row).document as Row).id as string;
    renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    await screen.findByLabelText('Bezeichnung 1');
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent(/1'0\d\d\.00/));
    // F3: refused at the press, in one line that names the position, the code and the fix.
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    expect(await screen.findByText('Position 1 mit UST77 braucht ein Leistungsdatum: setz das Datum auf den Tag der Leistung.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(w.calls.some((c) => c.verb === 'issue_invoice')).toBe(false);
    // The person states the Datum (a 2023 supply): the engine prices it at 7.7% and issues.
    fireEvent.change(screen.getByLabelText('Datum'), { target: { value: '2023-06-01' } });
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("1'077.00"));
    const said = await issueThroughConfirm();
    await waitFor(() => expect(w.row(id).status).toBe('issued'));
    const answer = w.calls.find((c) => c.verb === 'issue_invoice')!.body;
    expect({ said, error: answer.error ?? null, total: w.row(id).total_minor, documentDate: documentDate(w, id) }).toEqual({
      said: "Eine Buchung über CHF 1'077.00 wird erstellt.",
      error: null,
      total: 107700,
      documentDate: '2023-06-01',
    });
  });

  it('HISTORIC CODE: if the engine refuses needs_supply_date anyway, the confirm names the position and the fix, never a generic line', async () => {
    setNow('2026-10-04T09:00:00.000Z');
    const w = world();
    w.run('vat_code_upsert', { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'MWST 7.7% (bis 2023)', idempotencyKey: 'tc77' });
    const created = w.run('create_document', {
      type: 'invoice', contactId: w.contactId, currency: 'CHF',
      lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST77' }],
      idempotencyKey: 'd77b',
    });
    const id = ((created.body as Row).document as Row).id as string;
    // The preview reports the code's own rate, so the editor cannot see the era gap; the engine can.
    const transport: Transport = async (verb, input) =>
      verb === 'vat_preview' ? w.transport(verb, { ...input, supplyDate: '2023-06-01' }) : w.transport(verb, input);
    renderAt(transport, w.workspaceId, `/documents/${id}`);
    await screen.findByLabelText('Bezeichnung 1');
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Ausstellen/ }));
    expect(await within(dialog).findByText('Position 1 mit UST77 braucht ein Leistungsdatum. Setz das Datum auf den Tag der Leistung oder gib der Position ihr eigenes Leistungsdatum.')).toBeInTheDocument();
    expect(w.row(id).status).toBe('draft');
  });
});

describe('R4 engine probe: a stated line, a11y and the reset', () => {
  it('a stated Leistungsdatum (not a lifecycle day) is shown, previewed and posted at, the reset button has a name, and axe is clean', async () => {
    setNow('2024-01-05T09:00:00.000Z');
    const w = world();
    const created = w.run('create_document', {
      type: 'invoice', contactId: w.contactId, currency: 'CHF',
      lines: [
        { description: 'Montage', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-12-20' },
        { description: 'Wartung', quantityMilli: 1000, unitPriceMinor: 100000, taxCode: 'UST81' },
      ],
      idempotencyKey: 'mixed',
    });
    const id = ((created.body as Row).document as Row).id as string;
    const { container } = renderAt(w.transport, w.workspaceId, `/documents/${id}`);
    expect(await screen.findByText(/Leistungsdatum 20\.12\.2023/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Position 1 auf Datum setzen' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.documents-editor-totals')).toHaveTextContent("2'158.00"));
    vi.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
    // Back on the probe's clock: axe ran on real time, which is a different day (F2 would rightly
    // re-price at it). The person presses Ausstellen on 05.01.2024.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    setNow('2024-01-05T09:05:00.000Z');
    const said = await issueThroughConfirm();
    await waitFor(() => expect(w.row(id).status).not.toBe('draft'));
    expect(said).toContain("2'158.00");
    expect(w.row(id).total_minor).toBe(215800);
    expect(lastLines(w, id)).toEqual(['2023-12-20', null]);
  });
});
