/**
 * J04, the Inventory -> Cycle Counts / Inventur surface. The suite follows the Studio discipline: a
 * transport answers `whoami`, the session list and the session report, and copy is read from the
 * message fragment, never typed here. The money-path claim the UI must not break is that a count goes
 * through `inventory_stocktake_count` and a commit through `inventory_stocktake_commit`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import CycleCounts from './index';
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

const SESSION = (over: Record<string, unknown> = {}) => ({
  id: 'cyc_1',
  type: 'full',
  status: 'open',
  freezeAt: '2026-04-01',
  blindCount: false,
  progressPct: 0,
  totalLines: 1,
  countedLines: 0,
  reviewRequiredLines: 0,
  inventarDocumentId: null,
  notes: null,
  ...over,
});

const LINE = (over: Record<string, unknown> = {}) => ({
  id: 'ln_1',
  itemId: 'it_1',
  itemName: 'Widget',
  locationId: 'loc_a',
  locationName: 'Lager A',
  bookQty: 10,
  countedQty: null,
  varianceQty: null,
  status: 'pending',
  ...over,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith(['read_master_data', 'manage_master_data']),
  inventory_stocktake_list: ok({ sessions: [SESSION()], legacy: [] }),
  inventory_stocktake_report: ok({ session: SESSION(), lines: [LINE()], totals: { over: 0, under: 0, absVariance: 0, exceedingThreshold: 0 } }),
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <CycleCounts />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('CycleCounts, the stocktake surface', () => {
  it('lists a session and shows its frozen line with book quantity', async () => {
    renderSurface(baseCanned());
    // The session badge renders (full Inventur, open).
    expect(await screen.findAllByText(de.cycleCounts.status.open)).not.toHaveLength(0);
    // The detail line shows the frozen book quantity (not a blind hide).
    await waitFor(() => expect(screen.getByText('Widget')).toBeInTheDocument());
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('records a count through inventory_stocktake_count', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_stocktake_count = ok({ session: SESSION({ progressPct: 100 }), updatedLines: [LINE({ countedQty: 12, status: 'review_required' })] });
    renderSurface(canned, asked);

    await screen.findByText('Widget');
    await userEvent.type(screen.getByLabelText(de.cycleCounts.col.counted), '12');
    await userEvent.click(screen.getByRole('button', { name: de.cycleCounts.saveCount }));

    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_stocktake_count')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_stocktake_count');
    expect(call?.input.sessionId).toBe('cyc_1');
    const lines = call?.input.lines as Array<{ itemId: string; countedQty: number }>;
    expect(lines[0].countedQty).toBe(12);
    expect(lines[0].itemId).toBe('it_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('commit opens a confirm and fires inventory_stocktake_commit ONLY after the operator confirms (C4)', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    // A counted variance line, so the consequence sentence reports a real adjustment count.
    canned.inventory_stocktake_report = ok({
      session: SESSION({ status: 'review' }),
      lines: [LINE({ countedQty: 12, varianceQty: 2, status: 'approved' })],
      totals: { over: 2, under: 0, absVariance: 2, exceedingThreshold: 0 },
    });
    canned.inventory_stocktake_commit = ok({ session: SESSION({ status: 'committed' }), movementIds: ['mv_1'], movementsMinted: 1 });
    renderSurface(canned, asked);

    await screen.findByText('Widget');
    // First click opens the alertdialog and posts NOTHING.
    await userEvent.click(screen.getByRole('button', { name: de.cycleCounts.commit }));
    expect(await screen.findByText(de.cycleCounts.confirm.commitTitle)).toBeInTheDocument();
    // The dialog carries the statutory consequence sentence (full Inventur -> Bestandesnachweis OR 958c).
    expect(screen.getByText(/Bestandesnachweis nach OR 958c/)).toBeInTheDocument();
    expect(asked.some((a) => a.action === 'inventory_stocktake_commit')).toBe(false);

    // Confirm in the dialog: now, and only now, the commit fires.
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: de.cycleCounts.commit }));
    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_stocktake_commit')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_stocktake_commit');
    expect(call?.input.sessionId).toBe('cyc_1');
    expect(typeof call?.input.idempotencyKey).toBe('string');
  });

  it('cancel opens a confirm and fires inventory_stocktake_cancel ONLY after the operator confirms', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned = baseCanned();
    canned.inventory_stocktake_cancel = ok({ session: SESSION({ status: 'cancelled' }) });
    renderSurface(canned, asked);

    await screen.findByText('Widget');
    // First click opens the alertdialog and cancels NOTHING.
    await userEvent.click(screen.getByRole('button', { name: de.cycleCounts.cancel }));
    expect(await screen.findByText(de.cycleCounts.confirm.cancelTitle)).toBeInTheDocument();
    expect(asked.some((a) => a.action === 'inventory_stocktake_cancel')).toBe(false);

    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: de.cycleCounts.cancel }));
    await waitFor(() => expect(asked.some((a) => a.action === 'inventory_stocktake_cancel')).toBe(true));
    const call = asked.find((a) => a.action === 'inventory_stocktake_cancel');
    expect(call?.input.sessionId).toBe('cyc_1');
  });

  it('dismissing the commit confirm posts nothing', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);

    await screen.findByText('Widget');
    await userEvent.click(screen.getByRole('button', { name: de.cycleCounts.commit }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: de.cycleCounts.confirm.back }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(asked.some((a) => a.action === 'inventory_stocktake_commit')).toBe(false);
  });

  it('surfaces uncounted_or_unapproved_lines with the surface-scoped message after confirm', async () => {
    const canned = baseCanned();
    canned.inventory_stocktake_commit = reject('uncounted_or_unapproved_lines', { lines: [] });
    renderSurface(canned);

    await screen.findByText('Widget');
    await userEvent.click(screen.getByRole('button', { name: de.cycleCounts.commit }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: de.cycleCounts.commit }));
    expect(await screen.findByText(de.cycleCounts.errors.uncounted_or_unapproved_lines)).toBeInTheDocument();
  });

  it('hides the book column on a blind session until review', async () => {
    const canned = baseCanned();
    canned.inventory_stocktake_list = ok({ sessions: [SESSION({ blindCount: true })], legacy: [] });
    canned.inventory_stocktake_report = ok({ session: SESSION({ blindCount: true }), lines: [LINE({ bookQty: null })], totals: { over: 0, under: 0, absVariance: 0, exceedingThreshold: 0 } });
    renderSurface(canned);

    await screen.findByText('Widget');
    // The Book column header is absent while blind + open.
    expect(screen.queryByText(de.cycleCounts.col.book)).not.toBeInTheDocument();
  });
});
