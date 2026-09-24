/**
 * The G10 mapping editor. The claims worth the most:
 *
 *   A BLOCKING GAP IS NAMED WITH ITS FIGURE: an unmapped account carrying a balance is what OR 957a
 *   Klarheit forbids leaving silent, so the editor must surface it, not hide an incomplete map behind
 *   a clean screen.
 *
 *   EDITING A TARGET AND SAVING PERSISTS THE WHOLE MAP through `migration_set_map`, so a hand-typed
 *   account number actually reaches the plan.
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { MappingEditor } from './MappingEditor';
import de from './messages.de-CH.json';

type Handler = (input: Record<string, unknown>) => RestResponse;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Record<string, RestResponse | Handler>, calls: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

function tree(canned: Record<string, RestResponse | Handler>, calls: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, calls))}>
      <I18nProvider>
        <MappingEditor workspaceId="ws_1" planId="migplan_1" currency="CHF" />
      </I18nProvider>
    </TillClientProvider>
  );
}

const ACCOUNT_MAP = ok({
  mapId: 'migmap_1',
  entries: [{ source: '1000', sourceName: 'Kasse', balanceMinor: 123455, target: null }],
  complete: false,
  blocking: [{ source: '1000', sourceName: 'Kasse', balanceMinor: 123455 }],
  ignorable: [],
  collapsed: [],
  conflicts: [],
});

describe('MappingEditor', () => {
  it('names a blocking unmapped account with its figure', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ migration_get_map: ACCOUNT_MAP }, calls));
    // The column tab loads first; switch to accounts to reach the blocking case.
    fireEvent.click(screen.getByRole('tab', { name: de.migration.mapping.kind.account }));
    expect(await screen.findByText(de.migration.mapping.blocking.title.replace('{n}', '1'))).toBeTruthy();
    expect(screen.getAllByText("CHF 1'234.55").length).toBeGreaterThan(0);
  });

  it('a refused save NAMES the failure instead of returning in silence (role="alert")', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_get_map: ACCOUNT_MAP,
          migration_set_map: { status: 200, body: { ok: false, error: 'plan_not_editable' } },
        },
        calls,
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: de.migration.mapping.kind.account }));
    fireEvent.click(await screen.findByRole('button', { name: de.migration.mapping.save }));
    expect(await screen.findByText(de.migration.mapping.saveError)).toBeTruthy();
    // The silent-success line never appears on a rejected write.
    expect(screen.queryByText(de.migration.mapping.saved)).toBeNull();
  });

  it('a refused suggestion NAMES the failure instead of swallowing it (role="alert")', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_get_map: ACCOUNT_MAP,
          migration_suggest_map: { status: 200, body: { ok: false, error: 'suggest_failed' } },
        },
        calls,
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: de.migration.mapping.kind.account }));
    fireEvent.click(await screen.findByRole('button', { name: de.migration.mapping.suggest }));
    expect(await screen.findByText(de.migration.mapping.suggestError)).toBeTruthy();
  });

  it('G10 residual: Vorschlagen surfaces the suggested columns for a linked Saldenliste (empty draft)', async () => {
    // A linked bexio Saldenliste has NO saved map yet, so migration_get_map returns an empty entry
    // set and the draft starts empty. The engine's suggest seeds the columns from the linked vendor
    // adapter (Kontonummer -> account, Saldo -> balance). Before the fix the editor overlaid the
    // proposal onto the (empty) draft and dropped every column, so Vorschlagen showed nothing.
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_get_map: ok({
            mapId: null,
            entries: [],
            complete: false,
            blocking: [],
            ignorable: [],
            collapsed: [],
            conflicts: [],
          }),
          migration_suggest_map: ok({
            kind: 'column',
            source: 'adapter_preset',
            confidence: 1,
            entries: [
              { source: 'kontonummer', target: 'account' },
              { source: 'saldo', target: 'balance' },
            ],
          }),
        },
        calls,
      ),
    );

    // The column tab loads first; its draft is empty until a suggestion arrives.
    fireEvent.click(await screen.findByRole('button', { name: de.migration.mapping.suggest }));

    // Both discovered columns now appear as rows carrying their proposed target.
    const accountCell = await screen.findByLabelText(
      de.migration.mapping.targetFor.replace('{source}', 'kontonummer'),
    );
    expect((accountCell as HTMLInputElement).value).toBe('account');
    const balanceCell = screen.getByLabelText(
      de.migration.mapping.targetFor.replace('{source}', 'saldo'),
    );
    expect((balanceCell as HTMLInputElement).value).toBe('balance');
    // The proposal names where it came from, so the operator sees the source before trusting it.
    expect(screen.getByText(de.migration.mapping.suggestSource.adapter_preset)).toBeTruthy();
  });

  it('persists an edited target through migration_set_map', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_get_map: ACCOUNT_MAP,
          migration_set_map: ok({ mapId: 'migmap_1', complete: true, blocking: [], ignorable: [], completedMapId: 'migmap_1' }),
        },
        calls,
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: de.migration.mapping.kind.account }));
    const targetInput = await screen.findByLabelText(de.migration.mapping.targetFor.replace('{source}', '1000'));
    fireEvent.change(targetInput, { target: { value: '1020' } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.mapping.save }));

    await waitFor(() => {
      const saved = calls.find((c) => c.action === 'migration_set_map');
      expect(saved).toBeTruthy();
      expect(saved?.input.kind).toBe('account');
      const entries = saved?.input.entries as Array<{ source: string; target: string | null }>;
      expect(entries[0]?.target).toBe('1020');
    });
  });
});
