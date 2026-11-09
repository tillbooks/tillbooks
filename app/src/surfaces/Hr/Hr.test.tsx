/**
 * E02 Personal surface: the three tabs render, the roster reads, the AHV mask shows, the empty
 * states name the first action, and the four-eyes approve CTA is gated by capability.
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

const EMPLOYEE = { id: 'emp_1', firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01', ahvNr: '756-...', ahvRestricted: true };
const CLAIM = { id: 'clm_1', employeeId: 'emp_1', title: 'Reise Zürich', status: 'submitted', currency: 'CHF', totalBaseMinor: 4000 };

const base = (caps: string[], over: Canned = {}): Canned => ({
  whoami: whoamiWith(caps),
  hr_employee_list: ok({ employees: [EMPLOYEE] }),
  hr_absence_list: ok({ absences: [], selfScoped: false }),
  expense_claim_list: ok({ claims: [CLAIM], selfScoped: false }),
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

describe('Personal surface', () => {
  it('renders the three tabs and the roster, with the AHV masked', async () => {
    render(tree(base(['hr.read', 'hr.manage'])));
    expect(await screen.findByRole('tab', { name: 'Mitarbeitende' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Abwesenheiten' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Spesen' })).toBeInTheDocument();
    expect(await screen.findByText('Muster, Alex')).toBeInTheDocument();
    expect(screen.getByText(/zugriffsbeschränkt/)).toBeInTheDocument();
  });

  it('shows the Spesen approve CTA for an approver and hides it otherwise', async () => {
    const { unmount } = render(tree(base(['hr.read', 'spesen.approve'])));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    // K-21: the decision sits in the claim row's one overflow.
    await userEvent.click(await screen.findByRole('button', { name: /^Aktionen für Spesen/ }));
    expect(await screen.findByRole('menuitem', { name: 'Genehmigen & buchen' })).toBeInTheDocument();
    unmount();

    render(tree(base(['hr.read'])));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await screen.findByText('Reise Zürich');
    // Without the right there is no overflow at all, so no decision can be reached.
    expect(screen.queryByRole('button', { name: /^Aktionen für Spesen/ })).not.toBeInTheDocument();
  });

  it('empty roster names the first action', async () => {
    render(tree(base(['hr.read', 'hr.manage'], { hr_employee_list: ok({ employees: [] }) })));
    expect(await screen.findByText('Noch keine Mitarbeitenden.')).toBeInTheDocument();
    // K-33: the empty roster offers the first step, and it mirrors the header action.
    expect(screen.getAllByRole('button', { name: 'Mitarbeitende hinzufügen' }).length).toBeGreaterThan(0);
  });

  it('calls expense_claim_approve with confirm when the approver approves', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'spesen.approve'], { expense_claim_approve: ok({ claimId: 'clm_1', postedEntryId: 'je_1', confirmed: true }) }), asked));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Aktionen für Spesen/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Genehmigen & buchen' }));
    await waitFor(() => {
      const call = asked.find((a) => a.action === 'expense_claim_approve');
      expect(call).toBeDefined();
      expect(call?.input.confirm).toBe(true);
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
  });

  // D168: the approved claim's undo. It sits in the row overflow, marked destructive, and runs only
  // after an explicit confirm with a reason; nothing is sent before.
  const APPROVED = { ...CLAIM, status: 'approved' };

  it('offers Stornieren on an approved claim and calls expense_claim_reverse only after the confirm with a reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'spesen.approve', 'post'], {
      expense_claim_list: ok({ claims: [APPROVED], selfScoped: false }),
      expense_claim_reverse: ok({ claimId: 'clm_1', reversalEntryId: 'je_2' }),
    }), asked));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Aktionen für Spesen/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stornieren' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Korrekturbuchung');
    expect(asked.some((a) => a.action === 'expense_claim_reverse')).toBe(false);
    const confirm = screen.getByRole('button', { name: 'Abrechnung stornieren' });
    expect(confirm).toBeDisabled();
    expect(confirm.className).toContain('btn--danger');
    expect(confirm).not.toHaveAttribute('data-money-commit');

    await userEvent.type(screen.getByLabelText('Grund'), 'Doppelt erfasst');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => {
      const call = asked.find((a) => a.action === 'expense_claim_reverse');
      expect(call).toBeDefined();
      expect(call?.input.claimId).toBe('clm_1');
      expect(call?.input.reason).toBe('Doppelt erfasst');
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
  });

  it('cancelling the confirm sends nothing', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'spesen.approve', 'post'], { expense_claim_list: ok({ claims: [APPROVED], selfScoped: false }) }), asked));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Aktionen für Spesen/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stornieren' }));
    await screen.findByRole('alertdialog');
    const footerCancel = screen.getAllByRole('button', { name: 'Abbrechen' }).find((b) => b.className.includes('btn--secondary'));
    expect(footerCancel).toBeDefined();
    await userEvent.click(footerCancel as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(asked.some((a) => a.action === 'expense_claim_reverse')).toBe(false);
  });

  it('offers no Stornieren on a reimbursed or reversed claim, and names the reimbursed refusal in words', async () => {
    const { unmount } = render(tree(base(['hr.read', 'spesen.approve', 'post'], {
      expense_claim_list: ok({ claims: [{ ...CLAIM, status: 'reimbursed' }, { ...CLAIM, id: 'clm_2', title: 'Alt', status: 'reversed' }], selfScoped: false }),
    })));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    expect(await screen.findByText('Storniert')).toBeInTheDocument();
    for (const button of screen.queryAllByRole('button', { name: /^Aktionen für Spesen/ })) {
      await userEvent.click(button);
      expect(screen.queryByRole('menuitem', { name: 'Stornieren' })).not.toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
    }
    unmount();

    render(tree(base(['hr.read', 'spesen.approve', 'post'], {
      expense_claim_list: ok({ claims: [APPROVED], selfScoped: false }),
      expense_claim_reverse: { status: 422, body: { ok: false, error: 'claim_reimbursed', claimId: 'clm_1', paymentId: 'pay_1' } },
    })));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Aktionen für Spesen/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stornieren' }));
    await userEvent.type(await screen.findByLabelText('Grund'), 'Falsch');
    await userEvent.click(screen.getByRole('button', { name: 'Abrechnung stornieren' }));
    expect(await screen.findByText(/zuerst die Auszahlung stornieren/)).toBeInTheDocument();
  });
});
