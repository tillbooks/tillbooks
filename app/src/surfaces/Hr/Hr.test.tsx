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
    expect(await screen.findByRole('button', { name: 'Genehmigen & buchen' })).toBeInTheDocument();
    unmount();

    render(tree(base(['hr.read'])));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await screen.findByText('Reise Zürich');
    expect(screen.queryByRole('button', { name: 'Genehmigen & buchen' })).not.toBeInTheDocument();
  });

  it('empty roster names the first action', async () => {
    render(tree(base(['hr.read', 'hr.manage'], { hr_employee_list: ok({ employees: [] }) })));
    expect(await screen.findByText('Noch keine Mitarbeitenden.')).toBeInTheDocument();
  });

  it('calls expense_claim_approve with confirm when the approver approves', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree(base(['hr.read', 'spesen.approve'], { expense_claim_approve: ok({ claimId: 'clm_1', postedEntryId: 'je_1', confirmed: true }) }), asked));
    await userEvent.click(await screen.findByRole('tab', { name: 'Spesen' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Genehmigen & buchen' }));
    await waitFor(() => {
      const call = asked.find((a) => a.action === 'expense_claim_approve');
      expect(call).toBeDefined();
      expect(call?.input.confirm).toBe(true);
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
  });
});
