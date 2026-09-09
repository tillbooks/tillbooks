/**
 * E06's draft pane on the Korrespondenz route: the five states, the grounding statement as glyph +
 * label (never colour alone), the LIVE facts block in Swiss-formatted money, the specific inline
 * errors, and the permission posture (generate/regenerate hidden without `draft.write`, grounding
 * statement + facts hidden without `read_sales`, never shown-then-rejected).
 *
 * Copy is asserted through the catalogue, never as a literal typed here (the standing rule), and
 * every gate claim mounts a real `CapabilitiesProvider` (the hook fails open, so a test without
 * the provider measures the permissive default and calls it a permission test).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import Correspondence from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

const THREAD = {
  id: 'mailthr_1',
  accountId: 'mailacc_1',
  subject: 'Frage zur Rechnung',
  contactId: 'contact_1',
  lastMessageAt: '2026-07-29T06:00:00.000Z',
  lastDirection: 'inbound',
  messageCount: 1,
  draftReady: false,
  bucket: 'needs_reply',
};

const RUN = (over: Record<string, unknown> = {}) => ({
  id: 'draftrun_1',
  threadId: 'mailthr_1',
  grounded: true,
  status: 'ok',
  modelRef: 'stub-4b-q4',
  body: 'Guten Tag\nIhre Rechnung R-2026-0001 ist noch offen.\nFreundliche Grüsse',
  draftGone: false,
  modelChanged: false,
  ...over,
});

const BALANCE = ok({
  items: [
    { kind: 'document', number: 'R-2026-0001', openMinor: 123455, currency: 'CHF', dueDate: '2026-08-15' },
  ],
  baseTotalOpenMinor: 123455,
  baseCurrency: 'CHF',
});

const baseCanned = (): Canned => ({
  mail_threads_list: ok({ items: [THREAD], total: 1 }),
  mail_accounts_list: ok({
    accounts: [{ id: 'mailacc_1', adapter: 'thunderbird', address: 'praxis@example.ch', lastIndexedAt: null }],
  }),
  list_saved_views: ok({ savedViews: [] }),
  list_field_defs: ok({ entityKind: 'mail_thread', fieldDefs: [] }),
  mail_thread_get: ok({ thread: THREAD, messages: [], drafts: [] }),
  draft_list: ok({ runs: [], total: 0 }),
  customer_balance: BALANCE,
});

const whoamiWith = (capabilities: string[]): RestResponse =>
  ok({ actor: 'studio', role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

function tree(canned: Canned, withProvider = false) {
  const inner = (
    <MemoryRouter>
      <Correspondence />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

/** Open the fixture thread so the reading view (and the pane) mounts. */
async function openThread() {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(THREAD.subject) }));
  return screen.findByRole('region', { name: de.draft.pane.title });
}

describe('the draft pane, the empty and success states', () => {
  it('offers Entwurf erstellen on a thread with no draft yet, and never a bare blank panel', async () => {
    render(tree(baseCanned()));
    const pane = await openThread();
    expect(within(pane).getByText(de.draft.empty)).toBeInTheDocument();
    expect(within(pane).getByRole('button', { name: de.draft.action.generate })).toBeInTheDocument();
    // The P8 fact stated in place: the human sends in their own mail app.
    expect(within(pane).getByText(de.draft.review.note)).toBeInTheDocument();
  });

  it('generates through draft_generate with a fresh idempotency key, then shows the draft', async () => {
    const generateSpy = vi.fn<CannedHandler>(() =>
      ok({ draftRunId: 'draftrun_1', grounded: true, factsCount: 2 }),
    );
    let generated = false;
    const canned: Canned = {
      ...baseCanned(),
      draft_generate: (input) => {
        generated = true;
        return generateSpy(input);
      },
      draft_list: () => (generated ? ok({ runs: [RUN()], total: 1 }) : ok({ runs: [], total: 0 })),
    };
    render(tree(canned));
    const pane = await openThread();
    await userEvent.click(within(pane).getByRole('button', { name: de.draft.action.generate }));

    await waitFor(() => expect(generateSpy).toHaveBeenCalledTimes(1));
    const input = generateSpy.mock.calls[0]?.[0] ?? {};
    expect(input.threadId).toBe('mailthr_1');
    expect(typeof input.idempotencyKey).toBe('string');

    // The draft body arrives via draft_list (read on demand), never from the write's response.
    expect(await within(pane).findByText(/R-2026-0001 ist noch offen/)).toBeInTheDocument();
    // Grounding as glyph + label, and the LIVE facts block in Swiss tabular money.
    expect(within(pane).getByText(new RegExp(de.draft.grounded.on))).toBeInTheDocument();
    expect(within(pane).getByText(de.draft.grounded.facts)).toBeInTheDocument();
    expect(within(pane).getAllByText(/1'234\.55/).length).toBeGreaterThan(0);
  });

  it('regenerates with the hint chip, through draft_regenerate', async () => {
    const regenSpy = vi.fn<CannedHandler>(() => ok({ draftRunId: 'draftrun_2', grounded: true, factsCount: 2 }));
    render(tree({ ...baseCanned(), draft_list: ok({ runs: [RUN()], total: 1 }), draft_regenerate: regenSpy }));
    const pane = await openThread();
    await userEvent.click(await within(pane).findByRole('button', { name: de.draft.hint.shorter }));
    await waitFor(() => expect(regenSpy).toHaveBeenCalledTimes(1));
    expect(regenSpy.mock.calls[0]?.[0]).toMatchObject({ draftRunId: 'draftrun_1', hint: de.draft.hint.shorter });
  });
});

describe('the draft pane, the error states', () => {
  it('names needs_local_runtime specifically, with the no-cloud-fallback copy', async () => {
    render(tree({ ...baseCanned(), draft_generate: reject('needs_local_runtime') }));
    const pane = await openThread();
    await userEvent.click(within(pane).getByRole('button', { name: de.draft.action.generate }));
    expect(await within(pane).findByText(de.draft.error.needs_local_runtime)).toBeInTheDocument();
  });

  it('says a gone draft is gone and offers a fresh Entwurf erstellen instead of a phantom regenerate', async () => {
    render(tree({ ...baseCanned(), draft_list: ok({ runs: [RUN({ body: null, draftGone: true })], total: 1 }) }));
    const pane = await openThread();
    expect(await within(pane).findByText(de.draft.error.draft_gone)).toBeInTheDocument();
    expect(within(pane).getByRole('button', { name: de.draft.action.generate })).toBeInTheDocument();
    expect(within(pane).queryByRole('button', { name: de.draft.action.regenerate })).not.toBeInTheDocument();
  });

  it('says in words when a draft was written by a different model', async () => {
    render(tree({ ...baseCanned(), draft_list: ok({ runs: [RUN({ modelChanged: true })], total: 1 }) }));
    const pane = await openThread();
    expect(await within(pane).findByText(new RegExp('Mit einem anderen Modell erstellt'))).toBeInTheDocument();
  });
});

describe('the draft pane, the permission posture (real provider, never shown-then-rejected)', () => {
  it('hides generate/regenerate without draft.write, and the pane stays readable', async () => {
    const canned = {
      ...baseCanned(),
      whoami: whoamiWith(['mail.read', 'read_sales']),
      draft_list: ok({ runs: [RUN()], total: 1 }),
    };
    render(tree(canned, true));
    const pane = await openThread();
    expect(await within(pane).findByText(/R-2026-0001 ist noch offen/)).toBeInTheDocument();
    expect(within(pane).queryByRole('button', { name: de.draft.action.regenerate })).not.toBeInTheDocument();
    expect(within(pane).queryByRole('button', { name: de.draft.action.generate })).not.toBeInTheDocument();
  });

  it('hides the grounding statement AND the facts block without read_sales, whatever the flag says', async () => {
    const balanceSpy = vi.fn<CannedHandler>(() => BALANCE);
    const canned = {
      ...baseCanned(),
      whoami: whoamiWith(['mail.read', 'draft.write']),
      draft_list: ok({ runs: [RUN({ grounded: true })], total: 1 }),
      customer_balance: balanceSpy,
    };
    render(tree(canned, true));
    const pane = await openThread();
    expect(await within(pane).findByText(/R-2026-0001 ist noch offen/)).toBeInTheDocument();
    expect(within(pane).queryByText(new RegExp(de.draft.grounded.on))).not.toBeInTheDocument();
    expect(within(pane).queryByText(de.draft.grounded.facts)).not.toBeInTheDocument();
    // And the books were never even READ for this viewer: no laundering through a canned response.
    expect(balanceSpy).not.toHaveBeenCalled();
  });
});
