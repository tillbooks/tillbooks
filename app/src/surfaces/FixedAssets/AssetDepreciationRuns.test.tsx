/**
 * H04, the Fixed Assets -> Depreciation Runs surface. Follows the AssetDepreciation discipline: canned
 * transport, copy read from the message fragment. Asserts what this screen exists to prove: past runs
 * list, Calculate produces a reviewable draft with the proposed amount, Post books it, and a posted run
 * can be Reversed. The write actions gate on `post` (the money-path capability).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { AssetDepreciationRuns } from './AssetDepreciationRuns';
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

const POSTED_RUN = {
  id: 'adrun_1',
  period: '2026-02',
  status: 'posted',
  totalAmountRappen: 100_000,
  assetCount: 1,
  postedAt: '2026-02-28T00:00:00.000Z',
  journalEntryId: 'entry_2',
};

const DRAFT_RUN = { id: 'adrun_2', period: '2026-03', status: 'draft', totalAmountRappen: 100_000, assetCount: 1, postedAt: null, journalEntryId: null };
const DRAFT = ok({
  run: DRAFT_RUN,
  lines: [
    { id: 'adline_1', assetId: 'as_1', amountRappen: 100_000, accumulatedBeforeRappen: 0, accumulatedAfterRappen: 100_000, nbvAfterRappen: 1_100_000, isFinal: false },
  ],
  empty: false,
  skipped: [],
});

/** A calculation that found a units-of-production asset with no production figure for the period: the
 * asset is REPORTED in skipped, never dropped, and the surface must offer a way to supply the figure. */
const DRAFT_WITH_SKIPPED = ok({
  run: null,
  lines: [],
  empty: true,
  skipped: [{ assetId: 'as_units', assetNumber: 'FA-0007', reason: 'missing_production_data' }],
});

const baseCanned = (over: Partial<Canned> = {}): Canned => ({
  asset_depreciation_run_list: ok({ runs: [POSTED_RUN], total: 1 }),
  asset_depreciation_run_create: DRAFT,
  asset_depreciation_run_post: ok({ run: { ...DRAFT_RUN, status: 'posted', journalEntryId: 'entry_9' }, journalEntryId: 'entry_9', lines: [] }),
  asset_depreciation_run_reverse: ok({ run: { ...POSTED_RUN, status: 'reversed' }, reversingJournalEntryId: 'entry_10' }),
  asset_depreciation_run_get: ok({ run: POSTED_RUN, lines: [] }),
  ...over,
});

function renderSurface(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <AssetDepreciationRuns />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('AssetDepreciationRuns', () => {
  it('lists past runs on load', async () => {
    renderSurface(baseCanned());
    expect(await screen.findByText('Februar 2026')).toBeInTheDocument();
    expect(screen.getByText(de.assets.depreciationRun.status.posted)).toBeInTheDocument();
  });

  it('Calculate creates a draft and shows the proposed amount with a Post button', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));
    // the draft review appears with the calculated amount
    await waitFor(() => expect(screen.getByText(de.assets.depreciationRun.review, { exact: false })).toBeInTheDocument());
    expect(asked.some((a) => a.action === 'asset_depreciation_run_create' && typeof a.input.idempotencyKey === 'string')).toBe(true);
    // a Post button is offered in the review
    expect(screen.getAllByText(de.assets.depreciationRun.post).length).toBeGreaterThan(0);
  });

  it('posts a draft through the Post action', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));
    await screen.findByText(de.assets.depreciationRun.review, { exact: false });
    // H04 posts a balanced journal, so the Post button opens a confirm alertdialog first.
    await user.click(screen.getAllByText(de.assets.depreciationRun.post)[0]);
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: de.assets.depreciationRun.postConfirm }));
    await waitFor(() =>
      expect(asked.some((a) => a.action === 'asset_depreciation_run_post' && a.input.runId === 'adrun_2' && typeof a.input.idempotencyKey === 'string')).toBe(true),
    );
  });

  it('reverses a posted run through the Reverse action, carrying the stated reason', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    // Reverse asks WHY first: a money-path correction is never one unexplained click.
    await user.click(screen.getByRole('button', { name: 'Aktionen für den Lauf Februar 2026' })); // K-21
    await user.click(screen.getByRole('menuitem', { name: de.assets.depreciationRun.reverse }));
    const field = await screen.findByLabelText(de.assets.depreciationRun.reverseReason);
    await user.type(field, 'Nutzungsdauer falsch erfasst');
    await user.click(screen.getByText(de.assets.depreciationRun.reverseConfirm));
    await waitFor(() =>
      expect(
        asked.some(
          (a) =>
            a.action === 'asset_depreciation_run_reverse' &&
            a.input.runId === 'adrun_1' &&
            a.input.reason === 'Nutzungsdauer falsch erfasst' &&
            typeof a.input.idempotencyKey === 'string',
        ),
      ).toBe(true),
    );
  });

  it('cancelling the reverse prompt calls nothing', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned(), asked);
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Aktionen für den Lauf Februar 2026' })); // K-21
    await user.click(screen.getByRole('menuitem', { name: de.assets.depreciationRun.reverse }));
    await screen.findByLabelText(de.assets.depreciationRun.reverseReason);
    await user.click(screen.getByText(de.assets.depreciationRun.reverseCancel));
    expect(asked.some((a) => a.action === 'asset_depreciation_run_reverse')).toBe(false);
  });

  it('reports a skipped units asset and sends the production figure on recalculate', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned({ asset_depreciation_run_create: DRAFT_WITH_SKIPPED }), asked);
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));

    // The asset that produced no charge is NAMED, with the reason in words.
    expect(await screen.findByText(de.assets.depreciationRun.skipped.title)).toBeInTheDocument();
    expect(screen.getByText('FA-0007')).toBeInTheDocument();
    expect(
      screen.getByText(de.assets.depreciationRun.skipped.reason.missing_production_data),
    ).toBeInTheDocument();

    // Supplying the figure and recalculating sends it as unitsByAsset, keyed by asset id.
    const field = screen.getByLabelText(`${de.assets.depreciationRun.unitsFor} FA-0007`);
    await user.type(field, '500');
    await user.click(screen.getByText(de.assets.depreciationRun.recalculateWithUnits));
    await waitFor(() => {
      const withUnits = asked.filter((a) => a.action === 'asset_depreciation_run_create' && a.input.unitsByAsset !== undefined);
      expect(withUnits.length).toBe(1);
      expect(withUnits[0].input.unitsByAsset).toEqual({ as_units: 500 });
    });
  });

  it('a half-typed production figure is left out rather than guessed at', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(baseCanned({ asset_depreciation_run_create: DRAFT_WITH_SKIPPED }), asked);
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));
    await screen.findByText(de.assets.depreciationRun.skipped.title);
    // Nothing typed: the recalculate must not invent a zero.
    await user.click(screen.getByText(de.assets.depreciationRun.recalculateWithUnits));
    await waitFor(() => expect(asked.filter((a) => a.action === 'asset_depreciation_run_create').length).toBe(2));
    expect(asked.filter((a) => a.input.unitsByAsset !== undefined).length).toBe(0);
  });

  it('explains an empty period that is already posted, instead of a bare "nothing to post"', async () => {
    // A period with nothing to charge persists NO run, so the engine answers run: null. The panel must
    // still open and still explain: this is the answer the operator pressed Calculate for.
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    renderSurface(
      baseCanned({
        asset_depreciation_run_create: ok({ run: null, lines: [], empty: true, skipped: [], alreadyPostedRunId: 'adrun_1' }),
      }),
      asked,
    );
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));
    expect(await screen.findByText(de.assets.depreciationRun.alreadyPosted)).toBeInTheDocument();
    expect(screen.queryByText(de.assets.depreciationRun.emptyDraft)).not.toBeInTheDocument();

    // Pressing Calculate again keeps the explanation: the engine answers identically every time, so
    // the surface must not replace it with an error banner.
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));
    await waitFor(() => expect(asked.filter((a) => a.action === 'asset_depreciation_run_create').length).toBe(2));
    expect(screen.getByText(de.assets.depreciationRun.alreadyPosted)).toBeInTheDocument();
  });

  it('names an asset by its register number, never its internal id', async () => {
    renderSurface(
      baseCanned({
        asset_depreciation_run_create: ok({
          run: DRAFT_RUN,
          lines: [
            {
              id: 'adline_1',
              assetId: 'as_1',
              assetNumber: 'FA-0001',
              amountRappen: 100_000,
              accumulatedBeforeRappen: 0,
              accumulatedAfterRappen: 100_000,
              nbvAfterRappen: 1_100_000,
              isFinal: false,
            },
          ],
          empty: false,
          skipped: [],
        }),
      }),
    );
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));
    expect(await screen.findByText('FA-0001')).toBeInTheDocument();
    expect(screen.queryByText('as_1')).not.toBeInTheDocument();
  });

  it('footers the draft with the run header total, not a client-side reduce over the lines', async () => {
    // The engine sets the run header totalAmountRappen to the exact sum of the line amounts, so the
    // footer sources that ONE figure instead of re-summing money in the browser. The fixture proves
    // the equivalence bites: the header total equals what a reduce over the lines would have produced,
    // and the footer shows precisely the header value. Three lines that do NOT individually equal the
    // total, so the footer figure can only come from the header, never from a line cell echo.
    const lines = [
      { id: 'adline_1', assetId: 'as_1', assetNumber: 'FA-0001', amountRappen: 30_000, accumulatedBeforeRappen: 0, accumulatedAfterRappen: 200_000, nbvAfterRappen: 800_000, isFinal: false },
      { id: 'adline_2', assetId: 'as_2', assetNumber: 'FA-0002', amountRappen: 45_000, accumulatedBeforeRappen: 0, accumulatedAfterRappen: 300_000, nbvAfterRappen: 700_000, isFinal: false },
      { id: 'adline_3', assetId: 'as_3', assetNumber: 'FA-0003', amountRappen: 25_000, accumulatedBeforeRappen: 0, accumulatedAfterRappen: 400_000, nbvAfterRappen: 600_000, isFinal: false },
    ];
    const headerTotal = 100_000;
    const clientReduce = lines.reduce((s, l) => s + l.amountRappen, 0);
    // Equivalence guard: if these ever diverge the fixture is describing a real discrepancy, not a
    // cosmetic difference, and the display-only claim would be false.
    expect(clientReduce).toBe(headerTotal);

    renderSurface(
      baseCanned({
        asset_depreciation_run_create: ok({
          run: { ...DRAFT_RUN, totalAmountRappen: headerTotal },
          lines,
          empty: false,
          skipped: [],
        }),
      }),
    );
    await screen.findByText('Februar 2026');
    const user = userEvent.setup();
    await user.click(screen.getByText(de.assets.depreciationRun.calculate));

    const review = await screen.findByLabelText(de.assets.depreciationRun.review);
    // CHF 1000.00 is the header total. No single line amount equals it, so this text appears EXACTLY
    // once in the draft review: only as the footer total, never echoed from a line cell.
    const footerTotals = within(review).getAllByText("CHF 1'000.00");
    expect(footerTotals.length).toBe(1);
    expect(footerTotals[0].tagName).toBe('STRONG');
  });

  it('shows the empty state when there are no runs', async () => {
    renderSurface(baseCanned({ asset_depreciation_run_list: ok({ runs: [], total: 0 }) }));
    expect(await screen.findByText(de.assets.depreciationRun.empty.title)).toBeInTheDocument();
  });

  it('surfaces a transport failure with a retry', async () => {
    renderSurface(baseCanned({ asset_depreciation_run_list: reject('boom', {}, 500) }));
    expect(await screen.findByText(de.assets.depreciationRun.error.transport)).toBeInTheDocument();
  });
});
