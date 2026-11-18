/**
 * A20 §13.2 (D205): "Lücke schliessen" takes ANY export in its one drop zone. The content decides, never the
 * name: XML goes to `import_camt_files`, a CSV or an Excel workbook opens the shared mapping step, the
 * engine's plan per gap, and `import_bank_statement` with `fill { from, to }` set to exactly that gap's
 * missing days, one call per gap (never `fill {}`). The transport is canned; every figure is synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { GapRepairDialog } from './GapRepairDialog';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const end = (id: string, number: number, date: string) => ({ statementRowId: id, documentId: null, number, year: 2026, fromDate: date, toDate: date });
const gap = (id: string, a: [string, number, string], b: [string, number, string], from: string, to: string) => ({
  gapId: id,
  bankAccountId: 'ba_1',
  source: 'book',
  after: end(...a),
  before: end(...b),
  missing: [{ year: 2026, from: a[1] + 1, to: b[1] - 1 }],
  oldYearTailUnknown: false,
  missingDates: { from, to },
  chains: false,
  differenceMinor: -25000,
  currency: 'CHF',
  refused: [],
  confirmable: false,
});
const GAP_A = gap('bst_50:bst_53', ['bst_50', 50, '2026-03-23'], ['bst_53', 53, '2026-03-28'], '2026-03-24', '2026-03-27');
const GAP_B = gap('bst_53:bst_56', ['bst_53', 53, '2026-03-28'], ['bst_56', 56, '2026-04-02'], '2026-03-29', '2026-04-01');

function tileWith(gaps: unknown[]) {
  return ok({ tile: { tile: 'bank_inbox', ok: true, accounts: [{ bankAccountId: 'ba_1', name: 'Geschäftskonto', currency: 'CHF' }], statementGaps: gaps, channels: [] } });
}

const MAPPING = { columns: { bookingDate: 'Datum', amount: 'Betrag', balance: 'Saldo' }, dateFormat: 'dd.mm.yyyy' };

function previewBody(input: Record<string, unknown>): RestResponse {
  const fill = input.fill as { from: string; to: string } | undefined;
  return ok({
    headers: ['Datum', 'Betrag', 'Saldo'],
    rows: [['25.03.2026', '250.00', '1765.50']],
    rowCount: 1,
    mapping: MAPPING,
    mappingSource: 'guessed',
    guessedMapping: MAPPING,
    delimiter: 'semicolon',
    headerRow: 1,
    preset: null,
    fedAccount: false,
    lines: [2],
    sample: [{ row: 2, bookingDate: '2026-03-25', valueDate: null, amountMinor: 25000, currency: 'CHF', text: null, counterparty: null, error: null }],
    separatorMismatch: null,
    container: input.format === 'xlsx' ? 'xlsx' : 'csv',
    ...(input.format === 'xlsx' ? { sheets: ['Auszug', 'Notizen'], sheet: 'Auszug' } : {}),
    ...(fill !== undefined
      ? {
          fill: {
            parts: [
              {
                status: 'ready',
                kind: 'range',
                targetFrom: fill.from,
                targetTo: fill.to,
                from: fill.from,
                to: fill.to,
                rows: 1,
                alreadyInBooks: 0,
                imported: 0,
                before: { kind: 'none', csvMinor: null },
                after: { kind: 'none', csvMinor: null },
                problems: [],
                closesTarget: true,
                closedGapIds: [],
              },
            ],
          },
        }
      : {}),
  });
}

function importBody(input: Record<string, unknown>): RestResponse {
  const fill = input.fill as { from: string; to: string };
  return ok({
    format: 'csv',
    statements: [{ part: 1, outcome: 'imported', txnCount: 1, warnings: [] }],
    imported: 1,
    fill: { parts: [{ status: 'imported', kind: 'range', targetFrom: fill.from, targetTo: fill.to, from: fill.from, to: fill.to, rows: 1, alreadyInBooks: 0, imported: 1, before: { kind: 'none', csvMinor: null }, after: { kind: 'none', csvMinor: null }, problems: [], closesTarget: true, closedGapIds: ['g'] }] },
  });
}

type Handler = (input: Record<string, unknown>) => RestResponse;

function setup(gapId: string, handlers: Record<string, RestResponse | Handler>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const h = handlers[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input as Record<string, unknown>) : h;
  };
  const onClose = vi.fn();
  const onResolved = vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <GapRepairDialog workspaceId="ws_test" bankAccountId="ba_1" gapId={gapId} onClose={onClose} onResolved={onResolved} />
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { calls, onClose, onResolved };
}

const csvFile = () => new File(['Datum;Betrag;Saldo\r\n25.03.2026;250.00;1765.50\r\n'], 'export.txt', { type: 'text/plain' });
/** A workbook is told by its first bytes (`PK\x03\x04`), whatever its name says. */
const xlsxFile = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])], 'export.csv', { type: 'text/csv' });

describe('GapRepairDialog: any export (A20 §13.2)', () => {
  it('a CSV opens the mapping step, the plan for the gap, and fills exactly its missing days', async () => {
    let reads = 0;
    const { calls, onResolved, onClose } = setup('bst_50:bst_53', {
      dashboard_tile: () => {
        reads += 1;
        return reads === 1 ? tileWith([GAP_A]) : tileWith([]);
      },
      bank_csv_preview: previewBody,
      import_bank_statement: importBody,
    });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), csvFile());
    expect(await screen.findByText('CSV-Export')).toBeInTheDocument();
    expect(await screen.findByText('24.03.2026 bis 27.03.2026: Damit ist die Lücke geschlossen.')).toBeInTheDocument();
    const first = calls.find((c) => c.action === 'bank_csv_preview');
    expect(first?.input).toMatchObject({ bankAccountId: 'ba_1', format: 'csv' });
    await userEvent.click(screen.getByRole('button', { name: 'Fehlende Tage importieren' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sent = calls.filter((c) => c.action === 'import_bank_statement');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({ format: 'csv', mapping: MAPPING, saveMapping: true, fill: { from: '2026-03-24', to: '2026-03-27' } });
    expect(calls.some((c) => c.action === 'import_camt_files')).toBe(false);
    expect(onResolved).toHaveBeenCalledWith('Die Lücke ist geschlossen: Auszüge 51–52 sind aus dem Export im Buch.');
  });

  it('gap=all sends ONE fill per gap, never fill {} and never one span', async () => {
    const { calls } = setup('all', { dashboard_tile: tileWith([GAP_A, GAP_B]), bank_csv_preview: previewBody, import_bank_statement: importBody });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), csvFile());
    await screen.findByText('29.03.2026 bis 01.04.2026: Damit ist die Lücke geschlossen.');
    await userEvent.click(screen.getByRole('button', { name: 'Fehlende Tage importieren' }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'import_bank_statement')).toHaveLength(2));
    const fills = calls.filter((c) => c.action === 'import_bank_statement').map((c) => c.input.fill);
    expect(fills).toEqual([
      { from: '2026-03-24', to: '2026-03-27' },
      { from: '2026-03-29', to: '2026-04-01' },
    ]);
    for (const c of calls.filter((x) => x.action === 'bank_csv_preview' || x.action === 'import_bank_statement')) {
      if (c.input.fill !== undefined) expect(Object.keys(c.input.fill as object)).toEqual(['from', 'to']);
    }
  });

  it('a workbook is found from its bytes (even named .csv): format xlsx, and a choice of worksheet', async () => {
    const { calls } = setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: previewBody, import_bank_statement: importBody });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), xlsxFile());
    expect(await screen.findByText('Excel-Export')).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'bank_csv_preview')?.input.format).toBe('xlsx');
    expect(await screen.findByLabelText('Tabellenblatt')).toBeInTheDocument();
  });

  it('a stretch proven by the neighbour sum carries its glyph, the words on hover; a boundary mismatch says why', async () => {
    const proven = (input: Record<string, unknown>): RestResponse => {
      const base = previewBody(input).body as Record<string, unknown>;
      const fill = base.fill as { parts: Record<string, unknown>[] } | undefined;
      if (fill === undefined) return { status: 200, body: base as RestResponse['body'] };
      return { status: 200, body: { ...base, fill: { parts: fill.parts.map((p) => ({ ...p, proof: 'neighbour_sum', sum: { expectedMinor: 25000, actualMinor: 25000, differenceMinor: 0 } })) } } as unknown as RestResponse['body'] };
    };
    setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: proven });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), csvFile());
    expect(await screen.findByRole('img', { name: /Durch die Summe geprüft/ })).toHaveAttribute('title', 'Durch die Summe geprüft: die Zeilen ergeben genau, was die Auszüge davor und danach offen lassen');
  });

  it('a boundary mismatch is named with its day, and nothing is offered to import', async () => {
    const mismatch = (input: Record<string, unknown>): RestResponse => {
      const base = previewBody(input).body as Record<string, unknown>;
      const fill = base.fill as { parts: Record<string, unknown>[] } | undefined;
      if (fill === undefined) return { status: 200, body: base as RestResponse['body'] };
      return { status: 200, body: { ...base, fill: { parts: fill.parts.map((p) => ({ ...p, status: 'blocked', closesTarget: false, proof: null, problems: [{ code: 'boundary_mismatch', side: 'before', day: '2026-03-23' }] })) } } as unknown as RestResponse['body'] };
    };
    setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: mismatch });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), csvFile());
    expect(await screen.findByText(/Am 23\.03\.2026 stehen im Export andere Beträge als im Buch\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fehlende Tage importieren' })).toBeDisabled();
  });

  it('M3: beside the raw cells stand the date and the signed amount the engine read', async () => {
    setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: previewBody });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), csvFile());
    expect(await screen.findByRole('columnheader', { name: 'Betrag gelesen' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'CHF +250.00' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: '25.03.2026' })).toHaveLength(2);
  });

  it('M3: a separator the file contradicts blocks the import and names the row and column', async () => {
    const contradicted = (input: Record<string, unknown>): RestResponse => {
      const base = previewBody(input).body as Record<string, unknown>;
      return { status: 200, body: { ...base, separatorMismatch: { row: 2, column: 'Betrag' } } as unknown as RestResponse['body'] };
    };
    setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: contradicted });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), csvFile());
    expect(await screen.findByText('Zeile 2, Spalte «Betrag»: die Datei schreibt ihre Beträge mit dem anderen Dezimalzeichen. Korrigiere das Dezimalzeichen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fehlende Tage importieren' })).toBeDisabled();
  });

  it('L4: a mixed drop takes the export, names it, and names the files it left', async () => {
    const { calls } = setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: previewBody, import_camt_files: ok({ statements: [] }) });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), [new File(['<Document><Stmt/></Document>'], 'tag.xml'), csvFile()]);
    expect(await screen.findByText('Genommen: export.txt. Nicht genommen: tag.xml. Lege entweder die camt.053-Dateien oder einen Export ab.')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'import_camt_files')).toBe(false);
    expect(await screen.findByText('CSV-Export')).toBeInTheDocument();
  });

  it('a refusal is named in words with its fix (an old .xls)', async () => {
    setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), bank_csv_preview: { status: 200, body: { ok: false, error: 'xls_unsupported', kind: 'ole' } } });
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), xlsxFile());
    expect(await screen.findByRole('alert')).toHaveTextContent('Diese Excel-Datei liest TILL nicht. Speichere sie als xlsx (ohne Passwort) oder als CSV.');
  });

  it('XML still goes to import_camt_files, and a binary file is refused before anything is sent', async () => {
    const { calls } = setup('bst_50:bst_53', { dashboard_tile: tileWith([GAP_A]), import_camt_files: ok({ statements: [] }) });
    const input = await screen.findByLabelText('Dateien wählen');
    await userEvent.upload(input, new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])], 'scan.pdf'));
    expect(await screen.findByText('Diese Datei liest TILL nicht. Lade camt.053, CSV oder Excel (xlsx) herunter.')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'bank_csv_preview' || c.action === 'import_camt_files')).toBe(false);
    await userEvent.upload(input, new File(['<Document><Stmt/></Document>'], 'day.xml'));
    await waitFor(() => expect(calls.some((c) => c.action === 'import_camt_files')).toBe(true));
  });
});
