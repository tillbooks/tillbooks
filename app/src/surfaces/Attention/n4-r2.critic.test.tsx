/**
 * Critic N4 round 2, non-author probes on the STUDIO side of the Pendenzen batch, at 1d1c420db. Rows are the
 * shape the engine sends (`test/critic/n4-r2.test.mjs` proves the engine half). "FINDING" tests pin a defect
 * as observed (they flip when it is fixed); "SOUND" tests hold what the critic checked and found to hold.
 * Synthetic by construction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { Attention } from './index';
import { bankVorschlag, draftedBankLine, groupedOf } from './testing';

type Call = { action: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function renderHub(handlers: Record<string, RestResponse | Handler>, caps: Partial<Capabilities> = {}) {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const entry = handlers[action];
    if (entry === undefined) return ok();
    return typeof entry === 'function' ? await entry((input ?? {}) as Record<string, unknown>) : entry;
  };
  const capabilities: Capabilities = { whoami: null, can: () => true, refresh: () => undefined, ...caps };
  const view = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={capabilities}>
            <MemoryRouter initialEntries={['/attention']}>
              <Attention />
            </MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...view, calls };
}

const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-batch-row]')];
const commit = () => document.querySelector<HTMLButtonElement>('button[data-batch-approve]');
const infoText = () => document.getElementById(commit()?.getAttribute('aria-describedby') ?? '')?.textContent ?? '';

/** A batchable "set the line aside" Vorschlag: it books nothing (ignore_bank_line posts no entry). */
const ignoreRow = (id: string, amountMinor: number, currency = 'CHF') =>
  bankVorschlag(id, { subtitleParams: { tool: 'ignore_bank_line', date: '2026-10-20', target: '', targetKind: 'ignore' }, amountMinor, currency, consequenceKey: 'agent.consequence.post', posts: false });

const DRAFTED = (ids: string[]) => ok({ actions: ids.map((id) => draftedBankLine(id, `Zeile ${id}`, 100)) });

beforeEach(() => {
  window.localStorage.clear();
});

describe('FINDING M2 (fixed, flipped): no money accent on a commit that books nothing', () => {
  it('ticking only a "set aside" Vorschlag leaves the commit quiet with no booking claim; ticking the booking lights it', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('b1'), ignoreRow('i1', -999)])), list_drafted_actions: DRAFTED(['b1', 'i1']) });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    // Tick the ignore row only (the second box).
    await userEvent.click(boxes()[1] as HTMLInputElement);
    expect(commit()).not.toHaveClass('btn--accent');
    expect(commit()).not.toHaveAttribute('data-money-commit');
    expect(commit()).toBeEnabled();
    // Ticking the booking too: now the run posts, and the commit is the money commit.
    await userEvent.click(boxes()[0] as HTMLInputElement);
    expect(commit()).toHaveClass('btn--accent');
    expect(commit()).toHaveAttribute('data-money-commit', 'approve_drafted_action book_bank_line');
  });
});

describe('LOW (fixed, flipped): the batch (i) total counts only what the run books', () => {
  it('a booking of CHF -45.20 and a set-aside of CHF -9.99 read "2 Vorschläge, CHF -45.20"', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('b1'), ignoreRow('i1', -999)])), list_drafted_actions: DRAFTED(['b1', 'i1']) });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await userEvent.click(screen.getByRole('checkbox', { name: /Vorschläge auswählen/ }));
    expect(infoText()).toMatch(/2 Vorschläge, CHF\s?-45\.20$/);
    expect(infoText()).not.toMatch(/55\.19|9\.99/);
  });
});

describe('SOUND: the batch (i) total is signed, per currency, never a defaulted currency', () => {
  it('a CHF debit, a EUR credit and a row with no line facts: CHF -45.20 · EUR 120.00, and the row without facts adds nothing', async () => {
    renderHub({
      attention_list: ok(
        groupedOf([
          bankVorschlag('b1'),
          bankVorschlag('b2', { amountMinor: 12000, currency: 'EUR' }),
          bankVorschlag('b3', { amountMinor: undefined, currency: undefined }),
        ]),
      ),
      list_drafted_actions: DRAFTED(['b1', 'b2', 'b3']),
    });
    await waitFor(() => expect(boxes()).toHaveLength(3));
    await userEvent.click(screen.getByRole('checkbox', { name: /Vorschläge auswählen/ }));
    const text = infoText();
    expect(text).toMatch(/CHF\s?-45\.20/);
    expect(text).toMatch(/EUR\s?120\.00/);
    expect(text).not.toMatch(/CHF\s?74\.80|CHF\s?165\.20/);
  });
});

describe('SOUND: only rows the engine marks batchable get a box and run', () => {
  it('a stale row, a changed row and a non-batchable bank Vorschlag (IBAN redirect) get no box; select-all runs the two batchable rows only', async () => {
    const rows = [
      bankVorschlag('b1'),
      bankVorschlag('s1', { stale: true, changedSinceProposal: true, batchable: false, decisionOptions: [{ id: 'check_in_bank', verb: null, labelKey: 'attention.act.checkInBank', role: 'link', input: {}, deepLink: { route: '/bank', params: { line: 'btx_s1' } } }] }),
      bankVorschlag('c1', { changedSinceProposal: true, batchable: false }),
      bankVorschlag('iban', { subtitleParams: { tool: 'set_creditor_bank_profile' }, amountMinor: undefined, currency: undefined, batchable: false }),
      // A row whose flag is missing (an older engine) is never batchable either.
      bankVorschlag('noflag', { batchable: undefined }),
      bankVorschlag('b2'),
    ];
    let reads = 0;
    const { calls } = renderHub({
      attention_list: () => {
        reads += 1;
        return ok(groupedOf(reads === 1 ? rows : []));
      },
      list_drafted_actions: DRAFTED(['b1', 's1', 'c1', 'iban', 'noflag', 'b2']),
      approve_drafted_action: ok({ status: 'executed' }),
    });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    await userEvent.click(screen.getByRole('checkbox', { name: /Vorschläge auswählen/ }));
    await userEvent.click(commit() as HTMLButtonElement);
    await screen.findByText(/2 genehmigt/);
    expect(calls.filter((c) => c.action === 'approve_drafted_action').map((c) => c.input.actionId)).toEqual(['b1', 'b2']);
  });

  it('nothing is ticked on arrival and the commit is the quiet, disabled secondary with no money claim', async () => {
    renderHub({ attention_list: ok(groupedOf([bankVorschlag('b1'), bankVorschlag('b2')])), list_drafted_actions: DRAFTED(['b1', 'b2']) });
    await waitFor(() => expect(boxes()).toHaveLength(2));
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(commit()).toBeDisabled();
    expect(commit()).not.toHaveClass('btn--accent');
    expect(commit()).not.toHaveAttribute('data-money-commit');
    expect(document.querySelectorAll('.btn--accent')).toHaveLength(0);
  });
});
