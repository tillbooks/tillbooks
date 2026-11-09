/**
 * A20 §12: the CSV gap fill in "Kontoauszug importieren". A ZKB export is recognised by its headings and
 * arrives mapped; on an account fed over EBICS only the missing days are offered; the engine's plan is
 * shown stretch by stretch (its rows, whether its balance meets the statement and the books) before the
 * import, and the import carries `fill`. A stretch that cannot be proven says why and is not offered. The
 * transport is canned per action; all figures, names and references synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ImportDialog } from './ImportDialog';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const ACCOUNTS = [{ id: 'ba_1', name: 'Geschäftskonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: 'acc_1020' }];
const HEADERS = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const CSV = `${HEADERS.map((h) => `"${h}"`).join(';')}\r\n"12.03.2026";"Debit Mobile Banking: Software Muster AG";"";"";"Z900000000102";"";"432.10";"";"12.03.2026";"1532.90";"";""\r\n`;
const ZKB_MAPPING = {
  columns: { bookingDate: 'Date', valueDate: 'Value date', debit: 'Debit CHF', credit: 'Credit CHF', text: 'Booking text', purpose: 'Payment purpose', counterparty: 'Details', reference: 'ZKB reference', instructedAmount: 'Amount details', instructedCurrency: 'Curr', balance: 'Balance CHF' },
  dateFormat: 'dd.mm.yyyy',
  decimalSeparator: '.',
  delimiter: 'semicolon',
  rowOrder: 'newest_first',
  referenceSuffix: 'strip_dash_number',
  counterpartyCut: 'first_comma',
};
const PREVIEW = {
  bankAccountId: 'ba_1',
  encoding: 'utf-8-bom',
  delimiter: 'semicolon',
  headerRow: 1,
  headers: HEADERS,
  rows: [['12.03.2026', 'Debit Mobile Banking: Software Muster AG', '', '', 'Z900000000102', '', '432.10', '', '12.03.2026', '1532.90', '', '']],
  rowCount: 1,
  mappingSource: 'guessed',
  mapping: ZKB_MAPPING,
  guessedMapping: ZKB_MAPPING,
  missing: [],
  unknownColumns: [],
  blocking: null,
  sample: [],
  preset: 'zkb_account_statement',
  fedAccount: true,
};
const HOLE = {
  part: 1,
  status: 'ready',
  kind: 'before_feed',
  gapId: null,
  targetFrom: '2026-03-06',
  targetTo: '2026-03-22',
  from: '2026-03-06',
  to: '2026-03-22',
  rows: 2,
  alreadyInBooks: 0,
  imported: 2,
  csvOpeningMinor: 196500,
  csvClosingMinor: 152790,
  openingMinor: 196500,
  closingMinor: 152790,
  before: { kind: 'books', date: '2026-03-05', ledgerMinor: 191076, csvMinor: 196500, differenceMinor: 5424 },
  after: { kind: 'statement', statementRowId: 'bst_50', messageType: 'camt053', number: 50, date: '2026-03-23', balanceMinor: 152790, csvMinor: 152790, differenceMinor: 0 },
  problems: [],
  closesTarget: true,
  closedGapIds: [],
  statementId: null,
  lines: [],
};
const BLOCKED = {
  ...HOLE,
  part: 2,
  status: 'blocked',
  kind: 'gap',
  gapId: 'g1',
  targetFrom: '2026-03-24',
  targetTo: '2026-03-27',
  from: '2026-03-24',
  to: '2026-03-27',
  rows: 1,
  before: { kind: 'statement', number: 50, date: '2026-03-23', balanceMinor: 151550, csvMinor: 151550, differenceMinor: 0 },
  after: { kind: 'statement', number: 53, date: '2026-03-28', balanceMinor: 180000, csvMinor: 176550, differenceMinor: -3450 },
  problems: [{ code: 'untied', side: 'after', differenceMinor: -3450 }],
  closesTarget: false,
};

function setup(plan: Record<string, unknown>[], imported: Record<string, unknown>) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    const i = input as Record<string, unknown>;
    calls.push({ action, input: i });
    if (action === 'bank_csv_preview') return ok(i.fill === undefined ? PREVIEW : { ...PREVIEW, fill: { scope: 'gaps', parts: plan } });
    if (action === 'import_bank_statement') return ok(imported);
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  const onImported = vi.fn();
  const onImportedFiles = vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <ImportDialog open workspaceId="ws_test" accounts={ACCOUNTS} initialFile={null} preferredAccountId="ba_1" onClose={vi.fn()} onImported={onImported} onImportedFiles={onImportedFiles} />
      </I18nProvider>
    </TillClientProvider>,
  );
  return { calls, onImported, onImportedFiles };
}

const upload = async () => {
  await userEvent.upload(screen.getByLabelText('Dateien wählen'), new File([CSV], 'Account statement.csv', { type: 'text/csv' }));
};

describe('ImportDialog: a CSV gap fill (A20 §12)', () => {
  it('a ZKB export on an EBICS account: mapped by the preset, only the missing days offered, the plan shown, the import carries fill', async () => {
    const { calls, onImported } = setup([HOLE], {
      format: 'csv',
      statements: [{ part: 1, outcome: 'imported', statementId: 'bst_77', fromDate: '2026-03-06', toDate: '2026-03-22', txnCount: 2, duplicates: 0, refusedLines: 0, warnings: [] }],
      imported: 2,
      duplicates: 0,
      refused: 0,
      skipped: [],
      mappingSaved: true,
      fill: { scope: 'gaps', parts: [{ ...HOLE, status: 'imported' }] },
    });
    await upload();
    expect(await screen.findByText('Erkannt: der CSV-Kontoauszug der ZKB. Die Spalten sind schon zugeordnet. Prüfe sie.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Nur die Tage, die im Buch fehlen' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: 'Die ganze Datei' })).toBeNull();
    expect(await screen.findByText('Vor dem ersten Auszug: 06.03.2026 bis 22.03.2026')).toBeInTheDocument();
    expect(screen.getByText('2 Zeilen neu')).toBeInTheDocument();
    expect(screen.getByText(/Schliesst an den Auszug vom 23\.03\.2026 an/)).toBeInTheDocument();
    expect(screen.getByText(/Die Buchhaltung weicht am 05\.03\.2026 um .*54\.24 ab/)).toBeInTheDocument();
    expect(screen.getByText('Damit ist die Lücke geschlossen.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fehlende Tage importieren' }));
    const imp = calls.find((c) => c.action === 'import_bank_statement');
    expect(imp?.input.fill).toEqual({});
    expect(imp?.input.mapping).toEqual(ZKB_MAPPING);
    expect(await screen.findByText('Vor dem ersten Auszug: 06.03.2026 bis 22.03.2026: importiert, die Lücke ist geschlossen.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ statementId: 'bst_77', txnCount: 2 }));
  });

  it('a stretch the statements contradict says why and is not offered; with nothing ready the import stays disabled', async () => {
    const { calls } = setup([BLOCKED], {});
    await upload();
    expect(await screen.findByText('Lücke 24.03.2026 bis 27.03.2026')).toBeInTheDocument();
    expect(screen.getByText(/Der Saldo schliesst nicht an den Auszug an: Differenz .*34\.50\. Von diesen Tagen kommt nichts ins Buch\./)).toBeInTheDocument();
    expect(screen.getByText(/Weicht vom Auszug vom 28\.03\.2026 ab/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fehlende Tage importieren' })).toBeDisabled();
    expect(calls.some((c) => c.action === 'import_bank_statement')).toBe(false);
  });

  it('a range: the dates go to the engine as fill { from, to }', async () => {
    const { calls } = setup([{ ...HOLE, kind: 'range' }], {});
    await upload();
    await userEvent.click(await screen.findByRole('radio', { name: 'Ein Zeitraum' }));
    await userEvent.type(screen.getByLabelText('Von'), '2026-03-10');
    await userEvent.type(screen.getByLabelText('Bis'), '2026-03-15');
    await screen.findByRole('button', { name: 'Zeitraum importieren' });
    const asked = calls.filter((c) => c.action === 'bank_csv_preview' && c.input.fill !== undefined).map((c) => c.input.fill);
    expect(asked).toContainEqual({ from: '2026-03-10', to: '2026-03-15' });
  });
});
