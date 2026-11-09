/**
 * A36 §4.7 (D150): "Kontoauszug importieren" takes several files. One file keeps `import_camt`;
 * several go to `import_camt_files` in one call, the outcomes are listed per statement in a live region,
 * and "Fertig" hands them to the inbox. The transport is canned per action; all figures synthetic.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ImportDialog } from './ImportDialog';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const IBAN = 'CH9300762011623852957';
const ACCOUNTS = [{ id: 'ba_1', name: 'Geschäftskonto', iban: IBAN, currency: 'CHF', ledgerAccountId: 'acc_1020' }];

function camtFile(name: string): File {
  return new File([`<Document><Stmt><Id>${name}</Id><Acct><Id><IBAN>${IBAN}</IBAN></Id></Acct></Stmt></Document>`], name, { type: 'text/xml' });
}

function setup(handlers: Record<string, RestResponse>) {
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
          accounts={ACCOUNTS}
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

describe('ImportDialog with several files', () => {
  it('two files: one import_camt_files call, each outcome listed, "Fertig" hands them over', async () => {
    const { calls, onImportedFiles, onClose } = setup({
      import_camt_files: ok({
        statements: [
          { file: 'tag-1.xml', part: 1, number: 1, year: 2026, fromDate: '2026-10-01', outcome: 'imported', txnCount: 3 },
          { file: 'tag-2.xml', part: 1, number: 2, year: 2026, fromDate: '2026-10-02', outcome: 'already_imported' },
        ],
      }),
    });
    const input = screen.getByLabelText('Dateien wählen');
    expect(input).toHaveAttribute('multiple');
    await userEvent.upload(input, [camtFile('tag-2.xml'), camtFile('tag-1.xml')]);
    const commit = await screen.findByRole('button', { name: '2 Dateien importieren' });
    await userEvent.click(commit);
    expect(await screen.findByText('Auszug 1 vom 01.10.2026: importiert, 3 Buchungen.')).toBeInTheDocument();
    expect(screen.getByText('Auszug 2 vom 02.10.2026: war schon im Buch.').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    const sent = calls.filter((c) => c.action === 'import_camt_files');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toMatchObject({ bankAccountId: 'ba_1' });
    expect((sent[0]?.input.files as { name: string }[]).map((f) => f.name)).toEqual(['tag-2.xml', 'tag-1.xml']);
    expect(calls.some((c) => c.action === 'import_camt')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(onImportedFiles).toHaveBeenCalledTimes(1);
    expect(onImportedFiles.mock.calls[0]?.[1]).toBe('ba_1');
    expect(onClose).toHaveBeenCalled();
  });

  it('one file keeps the single import_camt door', async () => {
    const { calls, onImported } = setup({ import_camt: ok({ statementId: 'bst_1', txnCount: 2, duplicate: false, skipped: [], warnings: [] }) });
    await userEvent.upload(screen.getByLabelText('Dateien wählen'), [camtFile('tag-1.xml')]);
    await userEvent.click(await screen.findByRole('button', { name: 'Importieren' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(calls.map((c) => c.action)).toEqual(['import_camt']);
  });
});
