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

  it('the wage upload is disabled without the post capability (belt and braces)', async () => {
    render(tree(base(['hr.read', 'hr.manage'])));
    await openLohn();
    const upload = await screen.findByLabelText('Lohndatei hochladen');
    expect(upload.getAttribute('disabled')).not.toBeNull();
    expect(screen.getAllByText('Erfordert Buchhaltung.').length).toBeGreaterThan(0);
  });
});
