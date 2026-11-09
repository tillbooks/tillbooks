/**
 * A34 Lohn tab: the export card produces a local hand-off and states the AHV posture (glyph + text),
 * the wage card previews then posts through wage_journal_post (confirm), and both money-path
 * affordances are gated by capability. The engine is the real gate; this only pre-hides.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import Hr from './index';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const whoamiWith = (caps: string[]): RestResponse =>
  ok({ actor: 'boss', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities: caps });

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const base = (caps: string[], over: Canned = {}): Canned => ({
  whoami: whoamiWith(caps),
  hr_employee_list: ok({ employees: [] }),
  hr_absence_list: ok({ absences: [] }),
  expense_claim_list: ok({ claims: [] }),
  list_payroll_handoffs: ok({ handoffs: [], total: 0 }),
  ...over,
});

function tree(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <Hr />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

async function openLohn() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Lohn' }));
}

describe('A34 Lohn tab', () => {
  it('shows the local-only note and the empty history, and exports on the CTA', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'hr.manage'], {
      payroll_handoff_export: ok({ exportId: 'phe_1', artifactDocumentId: 'sf_1', ahvIncluded: false, ahvExcludedReason: 'missing_hr_sensitive' }),
    }), asked));
    await openLohn();
    expect(await screen.findByText(/übermittelt nichts an Lohnanbieter/i)).toBeInTheDocument();
    expect(await screen.findByText('Noch keine Übergaben.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Übergabe exportieren' }));
    await waitFor(() => {
      const call = asked.find((a) => a.action === 'payroll_handoff_export');
      expect(call).toBeDefined();
      expect(call?.input.format).toBe('json');
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
    // Produced without AHV, and the surface says so (glyph + text, never silent).
    expect(await screen.findByText(/Ohne AHV-Nummern erstellt/)).toBeInTheDocument();
  });

  it('the export CTA is disabled without hr.manage', async () => {
    render(tree(base(['hr.read'])));
    await openLohn();
    expect((await screen.findByRole('button', { name: 'Übergabe exportieren' })).getAttribute('disabled')).not.toBeNull();
  });

  it('previews an uploaded wage file, then posts through wage_journal_post with confirm', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      wage_journal_post: (input) =>
        input.confirm === true
          ? ok({ wageJournalPostId: 'wjp_1', postedEntryId: 'je_1', entryId: 'je_1' })
          : ok({ preview: { entryDate: '2026-07-05', lines: [{ accountNumber: '5000', debitMinor: 500000, creditMinor: 0 }, { accountNumber: '2260', debitMinor: 0, creditMinor: 500000 }], totalDebitMinor: 500000, balanced: true } }),
    }), asked));
    await openLohn();

    const file = new File(['account_number,debit_rappen,credit_rappen\n5000,500000,0\n2260,0,500000\n'], 'lohn.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), file);

    // The preview renders the balanced entry.
    expect(await screen.findByText('5000')).toBeInTheDocument();
    const postBtn = await screen.findByRole('button', { name: 'Buchen' });
    await userEvent.click(postBtn);

    await waitFor(() => {
      const confirmCall = asked.find((a) => a.action === 'wage_journal_post' && a.input.confirm === true);
      expect(confirmCall).toBeDefined();
      expect(confirmCall?.input.fileRef).toBe('sf_wage');
      expect(typeof confirmCall?.input.idempotencyKey).toBe('string');
    });
  });

  it('D173: a second wage journal for the month is refused in plain words, naming the way out', async () => {
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      wage_journal_post: (input) =>
        input.confirm === true
          ? { status: 409, body: { ok: false, error: 'month_already_posted', month: '2026-07', wageJournalPostId: 'wjp_1', postedEntryId: 'je_1' } }
          : ok({ preview: { entryDate: '2026-07-05', lines: [{ accountNumber: '5000', debitMinor: 500000, creditMinor: 0 }, { accountNumber: '2260', debitMinor: 0, creditMinor: 500000 }], totalDebitMinor: 500000, balanced: true } }),
    })));
    await openLohn();
    const file = new File(['account_number,debit_rappen,credit_rappen\n5000,500000,0\n2260,0,500000\n'], 'lohn.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), file);
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/Für diesen Monat ist bereits ein Lohnjournal gebucht\. Storniere es zuerst/)).toBeInTheDocument();
  });

  const postingRowForKind = (over: Record<string, unknown> = {}) => ({
    type: 'posting', id: 'wjp_9', actor: 'boss', createdAt: '2026-11-25T08:00:00Z', entryDate: '2026-11-25',
    postedEntryId: 'je_9', reversalEntryId: null, lineCount: 3, ...over,
  });
  const pvLines ={ entryDate: '2026-07-05', lines: [{ accountNumber: '5000', debitMinor: 500000, creditMinor: 0 }, { accountNumber: '2260', debitMinor: 0, creditMinor: 500000 }], totalDebitMinor: 500000, balanced: true };
  const standingWarning = { code: 'month_already_posted', month: '2026-07', standing: [{ wageJournalPostId: 'wjp_1', postedEntryId: 'je_1', entryDate: '2026-07-05' }] };

  it('D173 warn: the preview and the posted result name the standing journal of the month', async () => {
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      wage_journal_post: (input) =>
        input.confirm === true
          ? ok({ wageJournalPostId: 'wjp_2', postedEntryId: 'je_2', warnings: [standingWarning] })
          : ok({ preview: pvLines, warnings: [standingWarning] }),
    })));
    await openLohn();
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), new File(['x'], 'lohn.csv', { type: 'text/csv' }));
    expect(await screen.findByText(/Für 2026-07 steht bereits ein Lohnjournal/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Buchen' }));
    expect(await screen.findByText(/Gebucht\. Für 2026-07 steht nun mehr als ein Lohnjournal/)).toBeInTheDocument();
  });

  it('D173 supplementary: the toggle asks for a reason, and the post carries supplementary and the reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      wage_journal_post: (input) =>
        input.confirm === true ? ok({ wageJournalPostId: 'wjp_2', postedEntryId: 'je_2' }) : ok({ preview: pvLines }),
    }), asked));
    await openLohn();
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), new File(['x'], 'lohn.csv', { type: 'text/csv' }));
    await userEvent.click(await screen.findByLabelText(/Nachtragsbuchung \(/));
    const postBtn = screen.getByRole('button', { name: 'Buchen' });
    expect(postBtn).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Grund der Nachtragsbuchung'), 'Bonus nachgereicht');
    expect(postBtn).toBeEnabled();
    await userEvent.click(postBtn);
    await waitFor(() => {
      const sent = asked.find((a) => a.action === 'wage_journal_post' && a.input.confirm === true);
      expect(sent?.input.supplementary).toBe(true);
      expect(sent?.input.supplementaryReason).toBe('Bonus nachgereicht');
    });
  });

  it('D173 run kind: the picker defaults to Regulär, sends the chosen kind, and the history names a non-regular run', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      list_payroll_handoffs: ok({ handoffs: [postingRowForKind({ runKind: 'thirteenth' })], total: 1 }),
      wage_journal_post: (input) =>
        input.confirm === true ? ok({ wageJournalPostId: 'wjp_2', postedEntryId: 'je_2', runKind: input.runKind }) : ok({ preview: pvLines }),
    }), asked));
    await openLohn();
    expect(await screen.findByRole('cell', { name: /je_9 · 13\. Monatslohn/ })).toBeInTheDocument();
    const picker = screen.getByLabelText('Lohnlauf') as HTMLSelectElement;
    expect(picker.value).toBe('regular');
    await userEvent.selectOptions(picker, 'bonus');
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), new File(['x'], 'lohn.csv', { type: 'text/csv' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    await waitFor(() => {
      const sent = asked.find((a) => a.action === 'wage_journal_post' && a.input.confirm === true);
      expect(sent?.input.runKind).toBe('bonus');
    });
    expect(asked.find((a) => a.action === 'wage_journal_post' && a.input.confirm !== true)?.input.runKind).toBe('bonus');
  });

  it('D173 Q14: a correction run asks for its reason (default setting), the upload waits for it, and both calls carry it', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      wage_journal_post: (input) =>
        input.confirm === true ? ok({ wageJournalPostId: 'wjp_3', postedEntryId: 'je_3', runKind: input.runKind }) : ok({ preview: pvLines }),
    }), asked));
    await openLohn();
    const picker = await screen.findByLabelText('Lohnlauf');
    await userEvent.selectOptions(picker, 'bonus');
    expect(screen.queryByLabelText('Grund für diesen Lohnlauf')).toBeNull();
    expect(screen.getByLabelText('Grund für diesen Lohnlauf (optional)')).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'correction');
    const reason = screen.getByLabelText('Grund für diesen Lohnlauf');
    expect(screen.getByLabelText('Lohndatei hochladen')).toBeDisabled();
    await userEvent.type(reason, 'Falscher Satz im Juni');
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), new File(['x'], 'lohn.csv', { type: 'text/csv' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    await waitFor(() => {
      const calls = asked.filter((a) => a.action === 'wage_journal_post');
      expect(calls).toHaveLength(2);
      for (const c of calls) {
        expect(c.input.runKind).toBe('correction');
        expect(c.input.runKindReason).toBe('Falscher Satz im Juni');
      }
    });
  });

  it('D173 critic r3 LOW: a bonus offers an optional reason under the default, and a given one is sent', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'post'], {
      files_upload: ok({ file: { id: 'sf_wage' } }),
      wage_journal_post: (input) =>
        input.confirm === true ? ok({ wageJournalPostId: 'wjp_4', postedEntryId: 'je_4', runKind: input.runKind }) : ok({ preview: pvLines }),
    }), asked));
    await openLohn();
    await userEvent.selectOptions(await screen.findByLabelText('Lohnlauf'), 'bonus');
    expect(screen.getByLabelText('Lohndatei hochladen')).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Grund für diesen Lohnlauf (optional)'), 'Jahresbonus');
    await userEvent.upload(screen.getByLabelText('Lohndatei hochladen'), new File(['x'], 'lohn.csv', { type: 'text/csv' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Buchen' }));
    await waitFor(() => {
      const sent = asked.find((a) => a.action === 'wage_journal_post' && a.input.confirm === true);
      expect(sent?.input.runKindReason).toBe('Jahresbonus');
    });
  });

  it('D173 Q14: under the setting all, a bonus asks for a reason too', async () => {
    render(tree(base(['hr.read', 'post'], {
      settings_get: ok({ setting: { key: 'payroll.nonregular_reason', value: 'all' } }),
    })));
    await openLohn();
    const picker = await screen.findByLabelText('Lohnlauf');
    await waitFor(async () => {
      await userEvent.selectOptions(picker, 'bonus');
      expect(screen.getByLabelText('Grund für diesen Lohnlauf')).toBeInTheDocument();
    });
  });

  // D171: a standing posting offers Stornieren behind its row overflow and a confirm with a reason.
  const postingRow = (over: Record<string, unknown> = {}) => ({
    type: 'posting', id: 'wjp_1', actor: 'boss', createdAt: '2026-07-05T08:00:00Z', entryDate: '2026-07-05',
    postedEntryId: 'je_1', reversalEntryId: null, lineCount: 3, ...over,
  });

  it('D171: reverses a standing posting only through the confirm, with the typed reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    let reversed = false;
    render(tree(base(['hr.read', 'post'], {
      list_payroll_handoffs: () => ok({ handoffs: [postingRow(reversed ? { reversalEntryId: 'je_2' } : {})], total: 1 }),
      wage_journal_reverse: () => { reversed = true; return ok({ wageJournalPostId: 'wjp_1', postedEntryId: 'je_1', reversalEntryId: 'je_2' }); },
    }), asked));
    await openLohn();

    await userEvent.click(await screen.findByRole('button', { name: 'Aktionen für die Lohnbuchung vom 05.07.2026' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stornieren' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Lohnjournal vom 05.07.2026 stornieren?');
    expect(dialog).toHaveTextContent(/Lohnzahlungen, Meldungen an AHV, BVG und Quellensteuer/);
    const confirm = screen.getByRole('button', { name: 'Lohnjournal stornieren' });
    expect(confirm).toBeDisabled();
    expect(asked.some((a) => a.action === 'wage_journal_reverse')).toBe(false);

    await userEvent.type(screen.getByLabelText('Grund'), 'Falsche Lohnperiode');
    await userEvent.click(confirm);
    await waitFor(() => {
      const call = asked.find((a) => a.action === 'wage_journal_reverse');
      expect(call?.input.wageJournalPostId).toBe('wjp_1');
      expect(call?.input.reason).toBe('Falsche Lohnperiode');
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
    expect(await screen.findByText('Das Lohnjournal ist storniert.')).toBeInTheDocument();
    // The reload shows the posting reversed, and it no longer offers the action.
    expect(await screen.findByText('Storniert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aktionen für die Lohnbuchung vom 05.07.2026' })).toBeNull();
  });

  it('D171: a refusal is said in words (a bank line holds the entry)', async () => {
    render(tree(base(['hr.read', 'post'], {
      list_payroll_handoffs: ok({ handoffs: [postingRow()], total: 1 }),
      wage_journal_reverse: { status: 422, body: { ok: false, error: 'owned_by', verb: 'reopen_bank_line', bankTxnId: 'bt_1' } },
    })));
    await openLohn();
    await userEvent.click(await screen.findByRole('button', { name: 'Aktionen für die Lohnbuchung vom 05.07.2026' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stornieren' }));
    await userEvent.type(screen.getByLabelText('Grund'), 'Falsch');
    await userEvent.click(screen.getByRole('button', { name: 'Lohnjournal stornieren' }));
    expect(await screen.findByText(/Öffne zuerst die Bankzeile unter Bank wieder/)).toBeInTheDocument();
  });

  it('D171: no reverse is offered without post', async () => {
    render(tree(base(['hr.read', 'hr.manage'], {
      list_payroll_handoffs: ok({ handoffs: [postingRow()], total: 1 }),
    })));
    await openLohn();
    expect(await screen.findByText(/Gebuchte Buchung je_1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aktionen für die Lohnbuchung/ })).toBeNull();
  });

  it('the wage upload is disabled without the post capability (belt and braces)', async () => {
    render(tree(base(['hr.read', 'hr.manage'])));
    await openLohn();
    const upload = await screen.findByLabelText('Lohndatei hochladen');
    expect(upload.getAttribute('disabled')).not.toBeNull();
    expect(screen.getAllByText('Erfordert Buchhaltung.').length).toBeGreaterThan(0);
  });
});
