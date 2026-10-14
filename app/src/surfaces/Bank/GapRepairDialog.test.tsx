/**
 * A36 §4.7 (D150), the gap repair dialog: it names the exact days and the ZKB eBanking steps, warns
 * never to choose "Alle nicht abgeholten Daten", takes several files at once and sends them to
 * `import_camt_files`, lists each statement's outcome in a live region, and closes (saying so) when the
 * gap is gone. Another bank gets neutral steps. A chained gap can be confirmed with a reason. The
 * transport is canned per action; every figure is synthetic.
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

const GAP = {
  gapId: 'bst_182:bst_187',
  bankAccountId: 'ba_zkb',
  source: 'book',
  after: { statementRowId: 'bst_182', documentId: null, number: 182, year: 2026, fromDate: '2026-09-22', toDate: '2026-09-22' },
  before: { statementRowId: 'bst_187', documentId: null, number: 187, year: 2026, fromDate: '2026-09-29', toDate: '2026-09-29' },
  missing: [{ year: 2026, from: 183, to: 186 }],
  oldYearTailUnknown: false,
  missingDates: { from: '2026-09-23', to: '2026-09-28' },
  chains: true,
  differenceMinor: 0,
  currency: 'CHF',
  refused: [],
  confirmable: true,
};

function tileWith(gaps: unknown[], bankName: string | null = 'ZKB') {
  return ok({
    tile: {
      tile: 'bank_inbox',
      ok: true,
      accounts: [{ bankAccountId: 'ba_zkb', name: 'Geschäftskonto', currency: 'CHF' }],
      statementGaps: gaps,
      channels: bankName === null ? [] : [{ connectionId: 'ebc_1', bankName, statementGaps: gaps }],
    },
  });
}

type Handler = (input: Record<string, unknown>) => RestResponse;

function setup(handlers: Record<string, RestResponse | Handler>, props: Partial<{ onClose: () => void; onResolved: (m: string) => void }> = {}) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const h = handlers[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input as Record<string, unknown>) : h;
  };
  const onClose = props.onClose ?? vi.fn();
  const onResolved = props.onResolved ?? vi.fn();
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="de-CH">
        <WorkspaceProvider initialId="ws_test">
          <GapRepairDialog workspaceId="ws_test" bankAccountId="ba_zkb" gapId="bst_182:bst_187" onClose={onClose} onResolved={onResolved} />
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { calls, onClose, onResolved };
}

function xmlFile(name: string): File {
  return new File([`<Document><Stmt><Id>${name}</Id></Stmt></Document>`], name, { type: 'text/xml' });
}

describe('GapRepairDialog', () => {
  it('names the gap, the exact days, the ZKB steps and the warning against "Alle nicht abgeholten Daten"', async () => {
    setup({ dashboard_tile: tileWith([GAP]) });
    expect(await screen.findByText('Geschäftskonto: Auszüge 183–186 fehlen (23.09.2026 bis 28.09.2026)')).toBeInTheDocument();
    expect(screen.getByText(/Der Saldo von Auszug 182 geht genau in Auszug 187 über: es fehlt kein Geld\./)).toBeInTheDocument();
    expect(screen.getByText(/Lade in ZKB eBanking die camt\.053-Auszüge für 22\.09\.2026 bis 29\.09\.2026 herunter.*die Tage davor und danach schaden nicht/)).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(steps).toEqual([
      'Öffne «Konto & Zahlungen» und dann «Datentransfer».',
      'Wähle «Datei abholen».',
      'Wähle das Format camt.053 und das Konto Geschäftskonto.',
      'Wähle beim Datenumfang «Alle erneut abholen», gib 22.09.2026 bis 29.09.2026 als Zeitraum ein und klicke «Abholen».',
    ]);
    expect(screen.getByRole('note')).toHaveTextContent('Wähle nicht «Alle nicht abgeholten Daten».');
    expect(screen.getByLabelText('Dateien wählen')).toHaveAttribute('multiple');
  });

  it('another bank gets neutral steps and no ZKB path', async () => {
    setup({ dashboard_tile: tileWith([GAP], 'Raiffeisen') });
    expect(await screen.findByText(/Lade im E-Banking deiner Bank die camt\.053-Auszüge für 22\.09\.2026 bis 29\.09\.2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Datentransfer/)).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('Lade die Auszüge nicht als «neue, noch nicht abgeholte» Daten herunter.');
  });

  it('several files go to import_camt_files in one call; each outcome is listed; the dialog closes when the gap is gone', async () => {
    let reads = 0;
    const onResolved = vi.fn();
    const onClose = vi.fn();
    const { calls } = setup(
      {
        dashboard_tile: () => {
          reads += 1;
          return reads === 1 ? tileWith([GAP]) : tileWith([]);
        },
        import_camt_files: ok({
          statements: [
            { file: 'a.xml', part: 1, number: 183, year: 2026, fromDate: '2026-09-23', outcome: 'imported', txnCount: 2 },
            { file: 'b.xml', part: 1, number: 184, year: 2026, fromDate: '2026-09-24', outcome: 'already_imported' },
          ],
        }),
      },
      { onResolved, onClose },
    );
    const input = await screen.findByLabelText('Dateien wählen');
    await userEvent.upload(input, [xmlFile('b.xml'), xmlFile('a.xml')]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sent = calls.filter((c) => c.action === 'import_camt_files');
    expect(sent).toHaveLength(1);
    expect((sent[0]?.input.files as { name: string }[]).map((f) => f.name)).toEqual(['b.xml', 'a.xml']);
    expect(sent[0]?.input.bankAccountId).toBe('ba_zkb');
    expect(typeof sent[0]?.input.idempotencyKey).toBe('string');
    expect(onResolved).toHaveBeenCalledWith('Die Lücke ist geschlossen: Auszüge 183–186 sind im Buch.');
  });

  it('a partial fill keeps the dialog open, names what is left, and shows each outcome with the refusal and its amount', async () => {
    let reads = 0;
    const rest = { ...GAP, gapId: 'bst_184:bst_187', after: { ...GAP.after, statementRowId: 'bst_184', number: 184 }, missing: [{ year: 2026, from: 185, to: 186 }], chains: false, differenceMinor: -50000, confirmable: false };
    const onClose = vi.fn();
    setup(
      {
        dashboard_tile: () => {
          reads += 1;
          return reads === 1 ? tileWith([GAP]) : tileWith([rest]);
        },
        import_camt_files: ok({
          statements: [
            { file: 'a.xml', part: 1, number: 184, year: 2026, fromDate: '2026-09-24', outcome: 'imported', txnCount: 1 },
            { file: 'b.xml', part: 1, number: 186, year: 2026, fromDate: '2026-09-26', outcome: 'refused', code: 'gap_refused', differenceMinor: 50000 },
          ],
        }),
      },
      { onClose },
    );
    await userEvent.upload(await screen.findByLabelText('Dateien wählen'), [xmlFile('a.xml'), xmlFile('b.xml')]);
    expect(await screen.findByText('Es fehlen noch Auszüge 185–186.')).toBeInTheDocument();
    expect(screen.getByText('Auszug 184 vom 24.09.2026: importiert, 1 Buchung.')).toBeInTheDocument();
    expect(screen.getByText(/Auszug 186 vom 26\.09\.2026: nicht importiert\. Er schliesst nicht an den Auszug davor an: dazwischen fehlen CHF 500\.00\./)).toBeInTheDocument();
    expect(screen.getByText('Es fehlen noch Auszüge 185–186.').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    expect(onClose).not.toHaveBeenCalled();
    // The rest does not chain: no confirmation is offered for it.
    expect(screen.queryByRole('button', { name: 'Nichts fehlt, bestätigen' })).toBeNull();
  });

  it('a chained gap is confirmed with a reason, as a person (confirmed: true)', async () => {
    let reads = 0;
    const onResolved = vi.fn();
    const { calls } = setup(
      {
        dashboard_tile: () => {
          reads += 1;
          return reads === 1 ? tileWith([GAP]) : tileWith([]);
        },
        confirm_statement_gap: ok({ confirmed: true }),
      },
      { onResolved },
    );
    const button = await screen.findByRole('button', { name: 'Nichts fehlt, bestätigen' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Grund'), 'Feiertage ohne Buchung');
    await userEvent.click(button);
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('Bestätigt: in der Lücke 183–186 fehlt nichts.'));
    const sent = calls.find((c) => c.action === 'confirm_statement_gap')?.input;
    expect(sent).toMatchObject({ bankAccountId: 'ba_zkb', afterStatementId: 'bst_182', beforeStatementId: 'bst_187', reason: 'Feiertage ohne Buchung', confirmed: true });
  });

  it('a gap that is gone says so', async () => {
    setup({ dashboard_tile: tileWith([]) });
    expect(await screen.findByText('Diese Lücke gibt es nicht mehr: die Auszüge sind inzwischen im Buch.')).toBeInTheDocument();
  });
});
