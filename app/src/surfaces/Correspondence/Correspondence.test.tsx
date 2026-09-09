/**
 * The Korrespondenz surface: E04's human face over the local mail index.
 *
 * The suite follows the Aufgaben discipline: every claim about a GATE mounts a real
 * `CapabilitiesProvider` over a transport that answers `whoami` (the hook fails open, so a test
 * without the provider measures the permissive default and calls it a permission test), a loading
 * assertion waits for the read to have STARTED, and copy is asserted through the catalogue, never
 * as a literal typed here.
 *
 * The E04-specific claims worth singling out: the connect affordance states the no-password fact
 * and names the two supported clients IN PLACE (US-E04.1: it states this, it does not merely imply
 * it); `needs_mailstore` renders the honest named-clients line rather than a stack trace; and a
 * stale message says so in words with the warning glyph, never colour alone.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Correspondence from './index';
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

// --- The engine's own payload shapes -----------------------------------------------------------

const THREAD = (over: Record<string, unknown> = {}) => ({
  id: 'mailthr_1',
  accountId: 'mailacc_1',
  subject: 'Terminverschiebung',
  contactId: null,
  lastMessageAt: '2026-07-14T07:30:00.000Z',
  lastDirection: 'inbound',
  messageCount: 3,
  draftReady: false,
  bucket: 'needs_reply',
  ...over,
});

const ACCOUNT = { id: 'mailacc_1', adapter: 'thunderbird', address: 'praxis@example.ch', enabled: true, lastIndexedAt: '2026-07-15T00:00:00.000Z', createdAt: '2026-07-01T00:00:00.000Z' };

const whoamiWith = (actor: string, capabilities: string[]): RestResponse =>
  ok({ actor, role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith('studio', ['mail.read', 'mail.write']),
  mail_threads_list: ok({ items: [THREAD()], total: 1 }),
  mail_accounts_list: ok({ accounts: [ACCOUNT], supportedAdapters: ['apple_mail', 'thunderbird'] }),
  list_saved_views: ok({ savedViews: [] }),
  list_field_defs: ok({ entityKind: 'mail_thread', fieldDefs: [] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean, asked?: Array<{ action: string; input: Record<string, unknown> }>) {
  const inner = (
    <MemoryRouter>
      <Correspondence />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderMail = (canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>) =>
  render(tree(canned, 'ws_test', false, asked));
const withCapabilities = (canned: Canned) => render(tree(canned, 'ws_test', true));

describe('Korrespondenz, the load states', () => {
  it('shows the loading skeleton once the queue read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Correspondence />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('mail_threads_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const node of statuses) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the padlock when the queue read is refused (the mail.read gate)', async () => {
    renderMail({ ...baseCanned(), mail_threads_list: reject('permission_denied', { capability: 'mail.read' }, 403) });
    expect(await screen.findByText(de.mail.error.permissionDenied.read)).toBeInTheDocument();
  });

  it('states the empty case as the connect affordance: no password, the two clients named', async () => {
    renderMail({
      ...baseCanned(),
      mail_threads_list: ok({ items: [], total: 0 }),
      mail_accounts_list: ok({ accounts: [], supportedAdapters: ['apple_mail', 'thunderbird'] }),
    });
    expect(await screen.findByText(de.mail.empty)).toBeInTheDocument();
    // The honesty lines render IN PLACE (US-E04.1), not behind a link.
    expect(screen.getByText(de.mail.connect.no_password)).toBeInTheDocument();
    expect(screen.getByText(de.mail.connect.supported)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: de.mail.action.connect })).toBeInTheDocument();
  });
});

describe('Korrespondenz, the queue', () => {
  it('groups threads into the three buckets, direction as glyph AND label, draft badge on drafted', async () => {
    const canned = {
      ...baseCanned(),
      mail_threads_list: ok({
        items: [
          THREAD(),
          THREAD({ id: 'mailthr_2', subject: 'Rechnung Juli', bucket: 'drafted', draftReady: true }),
          THREAD({ id: 'mailthr_3', subject: 'Danke', bucket: 'done', lastDirection: 'outbound' }),
        ],
        total: 3,
      }),
    };
    renderMail(canned);
    expect(await screen.findByRole('button', { name: `${de.mail.action.open}: Terminverschiebung` })).toBeInTheDocument();
    for (const key of ['needs_reply', 'drafted', 'done'] as const) {
      expect(screen.getByRole('heading', { name: new RegExp(de.mail.bucket[key]) })).toBeInTheDocument();
    }
    // Direction is text, not colour: the done row carries the outbound label.
    expect(screen.getAllByText(de.mail.direction.outbound).length).toBeGreaterThan(0);
    // The drafted thread carries the badge. "Entwurf bereit" is ALSO the section heading, so the
    // claim is that the words appear beyond the heading: once as a heading, once on the row.
    expect(screen.getAllByText(new RegExp(de.mail.draft.badge)).length).toBeGreaterThan(1);
  });

  it('opens a thread and renders bodies, the stale warning in words, and message_moved per message', async () => {
    const canned: Canned = {
      ...baseCanned(),
      mail_thread_get: ok({
        thread: { id: 'mailthr_1', accountId: 'mailacc_1', subject: 'Terminverschiebung', contactId: null },
        messages: [
          { id: 'm1', subject: 'Terminverschiebung', fromAddress: 'klient@example.org', direction: 'inbound', sentAt: '2026-07-13T06:00:00.000Z', body: 'Guten Tag, können wir verschieben?' },
          { id: 'm2', subject: 'Re: Terminverschiebung', fromAddress: 'praxis@example.ch', direction: 'outbound', sentAt: '2026-07-13T08:00:00.000Z', body: 'Ja, gerne.', stale: true },
          { id: 'm3', subject: 'Re: Terminverschiebung', fromAddress: 'klient@example.org', direction: 'inbound', sentAt: '2026-07-14T07:30:00.000Z', body: null, error: 'message_moved' },
        ],
        drafts: [],
      }),
    };
    renderMail(canned);
    await userEvent.click(await screen.findByRole('button', { name: `${de.mail.action.open}: Terminverschiebung` }));
    expect(await screen.findByText('Guten Tag, können wir verschieben?')).toBeInTheDocument();
    // The stale message says so in words (never colour alone), and the moved one names its state.
    expect(screen.getByText(new RegExp(de.mail.msg.stale))).toBeInTheDocument();
    expect(screen.getByText(de.mail.error.message_moved)).toBeInTheDocument();
  });

  it('has no axe violations on the loaded queue', async () => {
    const { container } = renderMail(baseCanned());
    await screen.findByRole('button', { name: `${de.mail.action.open}: Terminverschiebung` });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Korrespondenz, the gates (real CapabilitiesProvider, real whoami)', () => {
  it('hides connect and the label control without mail.write', async () => {
    const canned = {
      ...baseCanned(),
      whoami: whoamiWith('reader', ['mail.read']),
      mail_threads_list: ok({ items: [], total: 0 }),
      mail_accounts_list: ok({ accounts: [], supportedAdapters: ['apple_mail', 'thunderbird'] }),
    };
    withCapabilities(canned);
    expect(await screen.findByText(de.mail.empty)).toBeInTheDocument();
    // No connect affordance, and no "connect your Gmail" anything: the affordance simply is not there.
    expect(screen.queryByRole('button', { name: de.mail.action.connect })).not.toBeInTheDocument();
    expect(screen.queryByText(de.mail.connect.no_password)).not.toBeInTheDocument();
  });

  it('shows the label control with mail.write when a select field def exists', async () => {
    const canned = {
      ...baseCanned(),
      list_field_defs: ok({
        entityKind: 'mail_thread',
        fieldDefs: [{ fieldDefId: 'cfd_1', key: 'triage', type: 'select', options: ['dringend', 'normal'], labelI18n: { 'de-CH': 'Triage', en: 'Triage' }, required: false, archived: false, draft: false, sort: 0, defaultValue: null }],
      }),
      list_field_values: ok({ entityKind: 'mail_thread', entityId: 'mailthr_1', values: [] }),
    };
    withCapabilities(canned);
    await screen.findByRole('button', { name: `${de.mail.action.open}: Terminverschiebung` });
    expect(screen.getByText(de.mail.field.label)).toBeInTheDocument();
  });
});

describe('Korrespondenz, the writes', () => {
  it('connects over the wire and queues the first reindex; needs_mailstore renders its honest line', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      mail_threads_list: ok({ items: [], total: 0 }),
      mail_accounts_list: ok({ accounts: [], supportedAdapters: ['apple_mail', 'thunderbird'] }),
      mail_connect: ok({ accountId: 'mailacc_9', account: { ...ACCOUNT, id: 'mailacc_9' }, created: true }),
      mail_reindex: ok({ accountId: 'mailacc_9', indexed: 4, skipped: 0, removed: 0, skippedReasons: {} }),
    };
    renderMail(canned, asked);
    await screen.findByText(de.mail.empty);
    await userEvent.type(screen.getByLabelText(de.mail.connect.storePath), '/Users/x/Mail');
    await userEvent.type(screen.getByLabelText(de.mail.connect.address), 'praxis@example.ch');
    await userEvent.click(screen.getByRole('button', { name: de.mail.action.connect }));
    await waitFor(() => {
      const connect = asked.find((a) => a.action === 'mail_connect');
      expect(connect).toBeDefined();
      expect(connect?.input.adapter).toBe('apple_mail');
      expect(connect?.input.storePath).toBe('/Users/x/Mail');
      expect(typeof connect?.input.idempotencyKey).toBe('string');
      // The first reindex rides the connect (US-E04.1: "the first reindex is queued").
      expect(asked.find((a) => a.action === 'mail_reindex')?.input.accountId).toBe('mailacc_9');
    });
  });

  it('renders needs_mailstore as the named-clients refusal, never a stack trace', async () => {
    const canned: Canned = {
      ...baseCanned(),
      mail_threads_list: ok({ items: [], total: 0 }),
      mail_accounts_list: ok({ accounts: [], supportedAdapters: ['apple_mail', 'thunderbird'] }),
      mail_connect: reject('needs_mailstore', { storePath: '/nope' }),
    };
    renderMail(canned);
    await screen.findByText(de.mail.empty);
    await userEvent.type(screen.getByLabelText(de.mail.connect.storePath), '/nope');
    await userEvent.type(screen.getByLabelText(de.mail.connect.address), 'a@b.ch');
    await userEvent.click(screen.getByRole('button', { name: de.mail.action.connect }));
    expect(await screen.findByText(de.mail.error.needs_mailstore)).toBeInTheDocument();
    // The supported-clients line is still on screen, which IS the "what to do" half of the refusal.
    expect(screen.getByText(de.mail.connect.supported)).toBeInTheDocument();
  });
});
