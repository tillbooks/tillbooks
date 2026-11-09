/**
 * J05, the Inventory -> Reason Codes / Korrekturgründe surface. The suite follows the Studio
 * discipline: a transport answers `whoami` and the reason list, and copy is read from the message
 * fragment, never typed here. The claim the UI must not break is that a create goes through
 * `inventory_reason_create` and an archive through `inventory_reason_archive`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import ReasonCodes from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const REASON = (over: Record<string, unknown> = {}) => ({
  id: 'rsn_1',
  code: 'SCHWUND',
  name: 'Schwund',
  description: null,
  category: 'shrinkage',
  requiresNote: false,
  defaultForStocktake: false,
  isActive: true,
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  inventory_reason_list: ok({ reasons: [REASON()] }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <ReasonCodes />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('ReasonCodes, the adjustment reason catalog', () => {
  it('lists a reason code with its category', async () => {
    renderSurface(baseCanned());
    await waitFor(() => expect(screen.getByText('SCHWUND')).toBeInTheDocument());
    expect(screen.getAllByText(de.reasonCodes.category.shrinkage).length).toBeGreaterThan(0);
  });

  it('creates a reason code through inventory_reason_create', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_reason_create = ok({ reason: REASON({ id: 'rsn_2', code: 'BESCHAED' }) });
    renderSurface(canned, asked);

    await screen.findByText('SCHWUND');
    await userEvent.click(screen.getByRole('button', { name: de.reasonCodes.new }));
    await userEvent.type(screen.getByLabelText(de.reasonCodes.form.code), 'BESCHAED');
    await userEvent.type(screen.getByLabelText(de.reasonCodes.form.name), 'Beschädigung');
    await userEvent.click(screen.getByRole('button', { name: de.reasonCodes.save }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_reason_create')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_reason_create');
    expect(call?.input.code).toBe('BESCHAED');
    expect(call?.input.category).toBe('shrinkage');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('surfaces duplicate_code with the surface-scoped message', async () => {
    const canned = baseCanned();
    canned.inventory_reason_create = reject('duplicate_code', { code: 'SCHWUND' });
    renderSurface(canned);

    await screen.findByText('SCHWUND');
    await userEvent.click(screen.getByRole('button', { name: de.reasonCodes.new }));
    await userEvent.type(screen.getByLabelText(de.reasonCodes.form.code), 'SCHWUND');
    await userEvent.type(screen.getByLabelText(de.reasonCodes.form.name), 'Schwund');
    await userEvent.click(screen.getByRole('button', { name: de.reasonCodes.save }));

    expect(await screen.findByText(de.reasonCodes.errors.duplicate_code)).toBeInTheDocument();
  });

  it('archives an active reason through inventory_reason_archive', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_reason_archive = ok({ reason: REASON({ isActive: false }) });
    renderSurface(canned, asked);

    await screen.findByText('SCHWUND');
    // K-21: archiving sits behind the row's one overflow.
    await userEvent.click(screen.getByRole('button', { name: de.reasonCodes.rowActions.replace('{code}', 'SCHWUND') }));
    await userEvent.click(await screen.findByRole('menuitem', { name: de.reasonCodes.archive }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_reason_archive')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_reason_archive');
    expect(call?.input.id).toBe('rsn_1');
  });
});
