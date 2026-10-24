/**
 * D178 (spec A20 §11.7): "Kontoauszug importieren" takes MT940 and CSV beside camt. An MT940 names its
 * account in `:25:` and goes to `import_bank_statement`; a CSV opens the mapping step (the saved mapping
 * preselected by `bank_csv_preview`, the first rows as a table, one select per target field, a blocking
 * line that NAMES the missing column), imports with the mapping and saves it; the answer is shown before
 * the dialog closes and is handed to the inbox as before. The transport is canned per action; all
 * figures and names synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ImportDialog, statementKindOf } from './ImportDialog';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const refused = (error: string, data: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...data } });
const IBAN_A = 'CH9300762011623852957';
const IBAN_B = 'CH5604835012345678009';
const ACCOUNTS = [
  { id: 'ba_1', name: 'Geschäftskonto', iban: IBAN_A, currency: 'CHF', ledgerAccountId: 'acc_1020' },
  { id: 'ba_2', name: 'Sparkonto', iban: IBAN_B, currency: 'CHF', ledgerAccountId: 'acc_1021' },
];
const MT940 = [':20:T1', `:25:${IBAN_B}`, ':28C:4', ':60F:C261001CHF100,', ':61:2610021002D12,50NMSCNONREF//R1', ':86:Gebuehr', ':62F:C261002CHF87,50'].join('\n');
const CSV = 'Datum;Text;Belastung;Gutschrift\n02.10.2026;Miete;1500.00;\n03.10.2026;Kundin;;820.00\n';
const PREVIEW = {
  bankAccountId: 'ba_1',
  encoding: 'utf-8',
  delimiter: 'semicolon',
  headerRow: 1,
  headers: ['Datum', 'Text', 'Belastung', 'Gutschrift'],
  rows: [
    ['02.10.2026', 'Miete', '1500.00', ''],
    ['03.10.2026', 'Kundin', '', '820.00'],
  ],
  rowCount: 2,
  mappingSource: 'guessed',
  mapping: { columns: { text: 'Text', debit: 'Belastung', credit: 'Gutschrift' }, dateFormat: 'dd.mm.yyyy' },
  guessedMapping: { columns: {}, dateFormat: 'dd.mm.yyyy' },
  missing: ['bookingDate'],
  unknownColumns: [],
  blocking: 'map a column for the booking date',
  sample: [],
};
const ONE_STATEMENT = {
  bankAccountId: 'ba_1',
  format: 'csv',
  statements: [{ part: 1, outcome: 'imported', statementId: 'bst_9', fromDate: '2026-10-02', toDate: '2026-10-03', txnCount: 2, duplicates: 1, refusedLines: 1, warnings: ['possible_cross_format_duplicate'] }],
  imported: 2,
  duplicates: 1,
  refused: 1,
  skipped: [
    { part: 1, reason: 'cross_format_duplicate', entryRef: null, message: 'x' },
    { part: 1, reason: 'unreadable_date', row: 7, entryRef: null, message: 'x' },
  ],
  mappingSaved: true,
};

function setup(handlers: Record<string, RestResponse>, accounts = ACCOUNTS) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    return handlers[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  const onImported = vi.fn();
  const onImportedFiles = vi.fn();
  const onClose = vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <ImportDialog
          open
          workspaceId="ws_test"
          accounts={accounts}
          initialFile={null}
          preferredAccountId={null}
          onClose={onClose}
          onImported={onImported}
          onImportedFiles={onImportedFiles}
        />
      </I18nProvider>
    </TillClientProvider>,
  );
  return { calls, onImported, onImportedFiles, onClose };
}

const upload = async (name: string, content: string, type: string) => {
  await userEvent.upload(screen.getByLabelText('Dateien wählen'), new File([content], name, { type }));
};

describe('statementKindOf', () => {
  it('reads the format from the name, else from the content', () => {
    expect(statementKindOf('auszug.xml', '')).toBe('camt');
    expect(statementKindOf('auszug.sta', '')).toBe('mt940');
    expect(statementKindOf('auszug.csv', '')).toBe('csv');
    expect(statementKindOf('auszug.txt', MT940)).toBe('mt940');
    expect(statementKindOf('auszug.txt', CSV)).toBe('csv');
    expect(statementKindOf('export', '<?xml version="1.0"?><Document>')).toBe('camt');
  });
});

describe('ImportDialog with MT940 and CSV (D178)', () => {
  it('an MT940 preselects its account from :25:, imports through import_bank_statement, and shows the answer before closing', async () => {
    const { calls, onImported, onClose } = setup({
      import_bank_statement: ok({
        format: 'mt940',
        statements: [{ part: 1, outcome: 'imported', statementId: 'bst_1', fromDate: '2026-10-02', txnCount: 1, warnings: [] }],
        imported: 1,
        duplicates: 0,
        refused: 0,
        skipped: [],
      }),
    });
    await upload('auszug.sta', MT940, 'text/plain');
    expect(await screen.findByText('Erkannt: MT940')).toBeInTheDocument();
    expect(screen.getByText('Die Datei gehört zu «Sparkonto» (CH56 0483 5012 3456 7800 9).')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText('Neu: 1 · Schon im Buch: 0 · Nicht gelesen: 0')).toBeInTheDocument();
    const sent = calls.find((c) => c.action === 'import_bank_statement');
    expect(sent?.input).toMatchObject({ bankAccountId: 'ba_2', format: 'mt940', fileName: 'auszug.sta' });
    expect(typeof sent?.input.contentBase64).toBe('string');
    expect(calls.some((c) => c.action === 'import_camt')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ bankAccountId: 'ba_2', statementId: 'bst_1', txnCount: 1, duplicate: false }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a CSV waits for the account, then shows its rows and a blocking line that names the missing column', async () => {
    const { calls } = setup({ bank_csv_preview: ok(PREVIEW) });
    await upload('export.csv', CSV, 'text/csv');
    expect(await screen.findByText('Wähle zuerst das Bankkonto, damit TILL seine gespeicherte Zuordnung findet.')).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'bank_csv_preview')).toBe(false);
    await userEvent.click(screen.getByRole('combobox', { name: 'Bankkonto' }));
    await userEvent.click(await screen.findByRole('option', { name: /Geschäftskonto/ }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Miete')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Es fehlt die Spalte für das Buchungsdatum.');
    expect(screen.getByRole('button', { name: 'Importieren' })).toBeDisabled();
    expect(calls.find((c) => c.action === 'bank_csv_preview')?.input).toMatchObject({ bankAccountId: 'ba_1' });
  });

  it('assigning the column clears the block; the import carries the mapping, saves it, and the answer names a row that was not read', async () => {
    const { calls, onImported } = setup({ bank_csv_preview: ok(PREVIEW), import_bank_statement: ok(ONE_STATEMENT) }, [ACCOUNTS[0]!]);
    await upload('export.csv', CSV, 'text/csv');
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('combobox', { name: 'Buchungsdatum (Pflicht)' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Datum' }));
    expect(screen.queryByText('Es fehlt die Spalte für das Buchungsdatum.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText('Neu: 2 · Schon im Buch: 1 · Nicht gelesen: 1')).toBeInTheDocument();
    expect(screen.getByText('Zeile 7: Datum nicht lesbar')).toBeInTheDocument();
    expect(screen.getByText('Eine neue Zeile gleicht einer Zeile aus einem anderen Dateiformat. Prüfe sie im Bankeingang.')).toBeInTheDocument();
    const sent = calls.find((c) => c.action === 'import_bank_statement');
    expect(sent?.input).toMatchObject({
      format: 'csv',
      saveMapping: true,
      mapping: { columns: { bookingDate: 'Datum', text: 'Text', debit: 'Belastung', credit: 'Gutschrift' }, dateFormat: 'dd.mm.yyyy' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ statementId: 'bst_9', txnCount: 2 }));
  });

  it('critic M3: the separator and the header row can be corrected; the file is read again and the import carries them', async () => {
    // The re-read file's headings are guessed afresh: the canned answer guesses text, debit and credit.
    const { calls } = setup({ bank_csv_preview: ok({ ...PREVIEW, guessedMapping: PREVIEW.mapping }), import_bank_statement: ok(ONE_STATEMENT) }, [ACCOUNTS[0]!]);
    await upload('export.csv', CSV, 'text/csv');
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('combobox', { name: 'Trennzeichen' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Komma ( , )' }));
    await vi.waitFor(() => expect(calls.filter((c) => c.action === 'bank_csv_preview').length).toBe(2));
    const again = calls.filter((c) => c.action === 'bank_csv_preview')[1];
    expect(again?.input).toMatchObject({ bankAccountId: 'ba_1', mapping: { columns: {}, delimiter: 'comma' } });
    await userEvent.click(screen.getByRole('combobox', { name: 'Zeile mit den Spaltennamen' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Zeile 4' }));
    await vi.waitFor(() => expect(calls.filter((c) => c.action === 'bank_csv_preview').length).toBe(3));
    expect(calls.filter((c) => c.action === 'bank_csv_preview')[2]?.input).toMatchObject({ mapping: { delimiter: 'comma', headerRow: 4 } });
    await userEvent.click(screen.getByRole('combobox', { name: 'Buchungsdatum (Pflicht)' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Datum' }));
    await userEvent.click(screen.getByRole('button', { name: 'Importieren' }));
    await screen.findByText('Neu: 2 · Schon im Buch: 1 · Nicht gelesen: 1');
    expect(calls.find((c) => c.action === 'import_bank_statement')?.input).toMatchObject({ mapping: { delimiter: 'comma', headerRow: 4 } });
  });

  it('critic M2: a file of several accounts says so and names them', async () => {
    setup({ import_bank_statement: refused('mt940_several_accounts', { accounts: ['1100-9876.543', '1100-5555.111'] }) });
    await upload('auszug.sta', MT940, 'text/plain');
    await userEvent.click(await screen.findByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText(/Auszüge mehrerer Konten \(1100-9876\.543, 1100-5555\.111\)/)).toBeInTheDocument();
  });

  it('an EBICS-fed account says why it takes camt only', async () => {
    setup({ import_bank_statement: refused('bank_feed_account', { format: 'mt940' }) });
    await upload('auszug.sta', MT940, 'text/plain');
    await userEvent.click(await screen.findByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText(/Dieses Bankkonto wird über EBICS beliefert/)).toBeInTheDocument();
  });

  it('a refused statement is listed with its reason and handed over as a file outcome', async () => {
    const { onImportedFiles } = setup({
      import_bank_statement: ok({
        format: 'mt940',
        statements: [{ part: 1, outcome: 'refused', fromDate: '2026-10-02', txnCount: 0, warnings: [], code: 'account_mismatch', reason: 'x' }],
        imported: 0,
        duplicates: 0,
        refused: 0,
        skipped: [],
      }),
    });
    await upload('auszug.sta', MT940, 'text/plain');
    await userEvent.click(await screen.findByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText('Auszug 1 nicht importiert: die Datei gehört zu einem anderen Konto')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onImportedFiles).toHaveBeenCalledWith([expect.objectContaining({ outcome: 'refused', code: 'account_mismatch', number: 1 })], 'ba_2');
  });
});
