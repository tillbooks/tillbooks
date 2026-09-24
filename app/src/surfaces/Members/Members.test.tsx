/**
 * The Zugriff surface: the human face of A24.
 *
 * WHAT THIS SUITE IS CAREFUL ABOUT, because the surface has a specific way of being wrong that a
 * render test usually cannot see. `useCapabilities()` FAILS OPEN by design (`src/lib/capabilities.ts`):
 * with no provider in the tree, or before `whoami` answers, `can()` returns true and every control
 * renders enabled. That default is correct for the product (the engine is the gate; greying out a
 * working ledger over a transient read failure is the more expensive mistake) and it is a trap for a
 * test, because a component test that forgets the provider measures the permissive default and calls
 * it a permission test.
 *
 * So every block below that makes a claim about a GATE mounts a real `CapabilitiesProvider` over a
 * transport that answers `whoami`, and `withCapabilities` is the only render helper used for those.
 * The bare helper is kept for the states where permissions are not the subject.
 *
 * COPY IS ASSERTED THROUGH THE CATALOGUE, never as a literal typed here. Two reasons, and the second
 * is live right now: a literal is a second copy of a string that then drifts from the shipped one,
 * and the de-CH register is being converted to `du` (D56, which reverses D49) by another pass, which
 * would redden every sentence pinned by hand. Labels that are nouns ("Rollen", "Fest") are matched
 * directly; anything
 * that is a sentence is matched against `messages.de-CH.json` itself, so this suite tests the
 * MAPPING from an engine code to its sentence and stays silent about the wording.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Members from './index';
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
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const OWNER_MEMBER = {
  memberId: 'member_1',
  userId: 'user_1',
  email: null,
  displayName: null,
  actorId: 'studio',
  role: 'owner',
  status: 'active',
  invitedAt: '2026-01-15T00:00:00.000Z',
  acceptedAt: '2026-01-15T00:00:00.000Z',
};

/**
 * The MCP agent's seat, which D50's provisioning writes beside the Studio's own.
 *
 * A function rather than a constant because the role is what the D50 assertions vary: the notice
 * exists only while the agent is still at `owner`, and narrowing it is the whole point.
 */
const AGENT_MEMBER = (role = 'owner') => ({
  memberId: 'member_3',
  userId: 'user_3',
  email: null,
  displayName: null,
  actorId: 'agent',
  role,
  status: 'active',
  invitedAt: '2026-01-15T00:00:00.000Z',
  acceptedAt: '2026-01-15T00:00:00.000Z',
});

const PENDING_MEMBER = {
  memberId: 'member_2',
  userId: 'user_2',
  email: 'buchhalter@muster.ch',
  displayName: 'B. Halter',
  actorId: null,
  role: 'bookkeeper',
  status: 'pending',
  invitedAt: '2026-03-02T00:00:00.000Z',
  acceptedAt: null,
};

/** The capability registry, exactly as `list_roles` sends it beside the roles. */
const REGISTRY = [
  { id: 'post', group: 'money' },
  { id: 'pay', group: 'money' },
  { id: 'issue', group: 'money' },
  { id: 'send', group: 'money' },
  { id: 'manage_periods', group: 'compliance' },
  { id: 'unlock_period', group: 'compliance' },
  { id: 'vat_file', group: 'compliance' },
  { id: 'manage_vat_config', group: 'compliance' },
  { id: 'manage_chart', group: 'governance' },
  { id: 'manage_master_data', group: 'governance' },
  { id: 'manage_settings', group: 'governance' },
  { id: 'manage_members', group: 'governance' },
  { id: 'diagnostics.read', group: 'governance' },
];

const ALL_CAPABILITIES = REGISTRY.map((e) => e.id);

const ROLES = [
  { id: 'owner', name: 'owner', isBuiltin: true, isFixed: true, capabilities: ALL_CAPABILITIES, archived: false, memberCount: 1 },
  { id: 'viewer', name: 'viewer', isBuiltin: true, isFixed: true, capabilities: [], archived: false, memberCount: 0 },
  { id: 'bookkeeper', name: 'bookkeeper', isBuiltin: true, isFixed: false, capabilities: ['post', 'pay'], archived: false, memberCount: 1 },
  { id: 'treuhaender', name: 'treuhaender', isBuiltin: true, isFixed: false, capabilities: ['post', 'vat_file'], archived: false, memberCount: 0 },
  { id: 'agent', name: 'agent', isBuiltin: true, isFixed: false, capabilities: ['post'], archived: false, memberCount: 0 },
  { id: 'role_9', name: 'Nur Buchen', isBuiltin: false, isFixed: false, capabilities: ['post'], archived: false, memberCount: 0 },
  { id: 'role_8', name: 'Archiviert', isBuiltin: false, isFixed: false, capabilities: [], archived: true, memberCount: 0 },
];

const whoamiOwner = ok({
  actor: 'studio',
  provisioned: true,
  isMember: true,
  memberId: 'member_1',
  userId: 'user_1',
  role: 'owner',
  capabilities: ALL_CAPABILITIES,
});

/**
 * Phase 2c (F-11): the invite form is DISABLED in local mode (the engine mints on every invite and a
 * local token is redeemable by nobody), so every test that drives the form runs as a served owner.
 */
const whoamiOwnerServed = ok({
  actor: 'member:user_1',
  provisioned: true,
  isMember: true,
  memberId: 'member_1',
  userId: 'user_1',
  role: 'owner',
  capabilities: ALL_CAPABILITIES,
  identitySource: 'served_subject',
  subject: 'mara@seeblick.example',
});

const whoamiUnclaimed = ok({
  actor: 'studio',
  provisioned: false,
  isMember: false,
  memberId: null,
  userId: null,
  role: 'owner',
  capabilities: ALL_CAPABILITIES,
});

const whoamiViewer = ok({
  actor: 'agent',
  provisioned: true,
  isMember: true,
  memberId: 'member_2',
  userId: 'user_2',
  role: 'viewer',
  capabilities: [],
});

const baseCanned = (): Canned => ({
  whoami: whoamiOwner,
  list_members: ok({ members: [OWNER_MEMBER, PENDING_MEMBER] }),
  list_roles: ok({ roles: ROLES, registry: REGISTRY }),
});

/** Render WITHOUT a capabilities provider: for states where permissions are not the subject. */
function renderMembers(canned: Canned, workspaceId: string | null = 'ws_test') {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Members />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/** Render WITH the real provider, so `can()` answers from the canned `whoami` and not from the default. */
function withCapabilities(canned: Canned, workspaceId: string | null = 'ws_test') {
  return render(
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <CapabilitiesProvider>
            <MemoryRouter>
              <Members />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Members, the load states', () => {
  it('shows a loading skeleton while the member list is in flight', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Members />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The skeleton is the surface's first commit, so it proves nothing on its own: wait for the read
    // to be genuinely in flight before calling this a loading state.
    await transport.started('list_members');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the no-workspace state and calls no ctx verb at all', async () => {
    const spy = vi.fn<CannedHandler>(() => ok({ members: [] }));
    renderMembers({ ...baseCanned(), list_members: spy }, null);
    expect(await screen.findByRole('heading', { name: 'Zugriff' })).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders a padlock on permission_denied and an error banner on anything else', async () => {
    renderMembers({ ...baseCanned(), list_members: reject('permission_denied', { capability: 'manage_members' }, 403) });
    expect(await screen.findByText(de.members.error.permission_denied)).toBeInTheDocument();

    renderMembers({ ...baseCanned(), list_members: reject('store_busy') });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  });
});

describe('Members, the roster', () => {
  it('renders each member with their role, status and date, in Swiss format', async () => {
    renderMembers(baseCanned());
    const rows = await screen.findAllByRole('row');
    // One header row plus two members.
    expect(rows).toHaveLength(3);

    // The owner is a LOCAL SESSION identity: no email, no display name, so the surface says which
    // session it is rather than inventing a person. It NAMES the transport (D50): both seated actors
    // arrive here with a null name and a null email, so a shared label would leave an operator
    // unable to tell the Studio's own seat from the MCP agent's.
    const owner = within(rows[1] as HTMLElement);
    expect(owner.getByText(de.members.actor.studio)).toBeInTheDocument();
    expect(owner.getByText('Sitzung: studio')).toBeInTheDocument();
    expect(owner.getByText(de.members.status.active)).toBeInTheDocument();
    expect(owner.getByText('15.01.2026')).toBeInTheDocument();

    // The invitee is pending, and it is LABELLED pending: a pending member holds no capability at
    // all, and an operator who cannot tell the two apart will wonder why nothing works.
    const invitee = within(rows[2] as HTMLElement);
    expect(invitee.getByText('B. Halter')).toBeInTheDocument();
    expect(invitee.getByText(de.members.status.pending)).toBeInTheDocument();
    // The pending row shows its INVITED date, because it has no acceptance date to show.
    expect(invitee.getByText('02.03.2026')).toBeInTheDocument();
    expect(invitee.queryByText(/Sitzung:/)).toBeNull();
  });

  it('names a built-in role in German and a custom role exactly as its operator typed it', async () => {
    // `roleLabel` sends a BUILT-IN through the strict catalogue and renders a CUSTOM role verbatim.
    // Humanising a name someone typed would show them a word they did not write.
    withCapabilities(baseCanned());
    await screen.findAllByRole('row');
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    // Options portal to <body>; the disabled check-glyph is aria-hidden, so each option's
    // accessible name is exactly its role label.
    expect(screen.getByRole('option', { name: de.members.role.owner })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: de.members.role.treuhaender })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Nur Buchen' })).toBeInTheDocument();
    // The archived custom role is not assignable and must not be offered.
    expect(screen.queryByRole('option', { name: 'Archiviert' })).not.toBeInTheDocument();
  });

  it('says the workspace is unclaimed rather than calling the caller its owner', async () => {
    // The one notice that is not an error. Inviting somebody is ALSO the act of claiming ownership,
    // and an operator should not discover that afterwards.
    withCapabilities({ ...baseCanned(), whoami: whoamiUnclaimed, list_members: ok({ members: [] }) });
    await waitFor(() => expect(document.querySelector('.action-feedback')).not.toBeNull());
    expect(document.querySelector('.action-feedback')?.textContent).toBe(de.members.unclaimed);
  });
});

/** J6.5 / F-11: "Zugriff entziehen" opens a confirm; the act is its danger button. */
async function confirmRevoke() {
  const dialog = await screen.findByRole('alertdialog', { name: de.members.revokeConfirm.title });
  await userEvent.click(within(dialog).getByRole('button', { name: de.members.revokeConfirm.confirm }));
}

describe('Members, the writes', () => {
  it('invites with a FRESH idempotency key and shows the token, because nothing was sent', async () => {
    const invite = vi.fn<CannedHandler>(() => ok({ memberId: 'member_3', token: 'invite_77', delivery: 'prepared' }));
    withCapabilities({ ...baseCanned(), whoami: whoamiOwnerServed, invite_member: invite });
    await screen.findAllByRole('row');

    await userEvent.type(screen.getByLabelText('E-Mail'), 'neu@muster.ch');
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'treuhaender')!);
    await userEvent.click(screen.getByRole('button', { name: 'Einladen' }));

    await waitFor(() => expect(invite).toHaveBeenCalledOnce());
    const sent = invite.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', email: 'neu@muster.ch', role: 'treuhaender', kind: 'human' });
    expect(typeof sent.idempotencyKey).toBe('string');
    expect((sent.idempotencyKey as string).length).toBeGreaterThan(0);

    // TILL has no mail transport, so an invite that claimed to be on its way would be a delivery
    // guarantee this product cannot make offline. The token is handed over instead.
    expect(await screen.findByText('invite_77')).toBeInTheDocument();
  });

  it('changes a role and re-reads the list, so the table is never stale', async () => {
    const setRole = vi.fn<CannedHandler>(() => ok({ memberId: 'member_2', role: 'viewer' }));
    let listCalls = 0;
    withCapabilities({
      ...baseCanned(),
      list_members: () => {
        listCalls += 1;
        return ok({ members: [OWNER_MEMBER, PENDING_MEMBER] });
      },
      set_role: setRole,
    });
    await screen.findAllByRole('row');
    expect(listCalls).toBe(1);

    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'viewer')!);
    await waitFor(() => expect(setRole).toHaveBeenCalledOnce());
    expect(setRole.mock.calls[0][0]).toMatchObject({ memberId: 'member_2', role: 'viewer' });
    await waitFor(() => expect(listCalls).toBe(2));
  });

  it('revokes a member', async () => {
    const revoke = vi.fn<CannedHandler>(() => ok({ memberId: 'member_2', revoked: true }));
    withCapabilities({ ...baseCanned(), revoke_member: revoke });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getAllByRole('button', { name: 'Zugriff entziehen' })[1] as HTMLElement);
    await confirmRevoke();
    await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    expect(revoke.mock.calls[0][0]).toMatchObject({ memberId: 'member_2' });
  });

  it('renders last_owner in its own words, not as the generic failure', async () => {
    // The rail that stops a workspace being walked back into the ungated state. It is the one
    // rejection here that an operator can hit by doing something entirely reasonable, so a generic
    // "that did not work" would leave them with no idea why.
    withCapabilities({ ...baseCanned(), revoke_member: reject('last_owner', { memberId: 'member_1' }) });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getAllByRole('button', { name: 'Zugriff entziehen' })[0] as HTMLElement);
    await confirmRevoke();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(de.members.error.last_owner);
    expect(alert.textContent).not.toContain(de.members.error.generic);
  });

  it('names the missing capability when the engine denies a write', async () => {
    // `permission_denied` carries the capability the engine wanted. Rendering it is the difference
    // between "you may not" and "you need the right to manage access", which is a sentence an
    // operator can act on by asking the right person.
    withCapabilities({
      ...baseCanned(),
      revoke_member: reject('permission_denied', { capability: 'manage_members', role: 'bookkeeper' }),
    });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getAllByRole('button', { name: 'Zugriff entziehen' })[0] as HTMLElement);
    await confirmRevoke();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(de.capability.manage_members);
    expect(alert.textContent).not.toContain(de.members.error.generic);
  });
});

describe('Members, the capability gate on the surface itself', () => {
  it('offers no write control at all to an actor without manage_members', async () => {
    // Mounted over the REAL provider on purpose. Without it `can()` fails open and this block would
    // measure the permissive default while claiming to measure a gate.
    withCapabilities({ ...baseCanned(), whoami: whoamiViewer });
    await screen.findAllByRole('row');

    expect(screen.queryByRole('button', { name: 'Einladen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zugriff entziehen' })).toBeNull();
    // The Rollen tab is HIDDEN rather than disabled: a tab that opens onto nothing an actor may
    // change is a dead end, and the surface has no second thing to show behind it.
    expect(screen.queryByRole('tab', { name: de.members.tab.roles })).toBeNull();
    expect(screen.getByRole('tab', { name: de.members.tab.members })).toBeInTheDocument();

    // The role is still SHOWN, read-only, so a viewer can see what they hold.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByText(de.members.role.owner)).toBeInTheDocument();
  });

  it('offers every write control to an owner', async () => {
    withCapabilities(baseCanned());
    await screen.findAllByRole('row');
    expect(screen.getByRole('button', { name: 'Einladen' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: de.members.tab.roles })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Zugriff entziehen' })).toHaveLength(2);
  });
});

describe('Members, the Rollen tab', () => {
  async function openRoles() {
    withCapabilities(baseCanned());
    await screen.findAllByRole('row');
    await userEvent.click(screen.getByRole('tab', { name: de.members.tab.roles }));
    await screen.findByRole('button', { name: de.members.roles.define });
  }

  it('renders the two anchors as read-only and every other role as editable', async () => {
    await openRoles();
    const items = [...document.querySelectorAll('.members-role')];
    // Six assignable roles: the two anchors, the three editable built-ins and one custom role. The
    // archived custom role is filtered out.
    expect(items).toHaveLength(6);

    const fixed = [...document.querySelectorAll('.members-pill--fixed')];
    expect(fixed).toHaveLength(2);
    // Focusable and aria-disabled rather than a greyed-out thing with no explanation, and the engine
    // slug rides in the title so a denial can be traced.
    for (const pill of fixed) {
      expect(pill.getAttribute('aria-disabled')).toBe('true');
      expect(pill.getAttribute('tabindex')).toBe('0');
    }
    expect(fixed.map((p) => p.getAttribute('title')).sort()).toEqual(['owner', 'viewer']);

    // Only the CUSTOM role may be archived: a built-in is part of the vocabulary every spec names.
    expect(screen.getAllByRole('button', { name: de.members.roles.archive })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: de.members.roles.edit })).toHaveLength(4);
  });

  it("resolves the owner bundle to every capability and the viewer bundle to none", async () => {
    await openRoles();
    const items = [...document.querySelectorAll('.members-role')] as HTMLElement[];
    const byName = new Map(
      items.map((li) => [li.querySelector('.members-role-name')?.textContent ?? '', li]),
    );

    const ownerCaps = byName.get(de.members.role.owner)?.querySelector('.members-role-caps')?.textContent ?? '';
    for (const id of ALL_CAPABILITIES) {
      expect(ownerCaps).toContain(id === 'diagnostics.read' ? de.capability.diagnostics.read : de.capability[id as 'post']);
    }
    expect(byName.get(de.members.role.viewer)?.querySelector('.members-role-caps')?.textContent).toBe(
      de.members.roles.noCapabilities,
    );
  });

  it('sends only the ticked capabilities, with a fresh key, on a new role', async () => {
    const define = vi.fn<CannedHandler>(() => ok({ roleId: 'role_10', capabilities: ['post'] }));
    withCapabilities({ ...baseCanned(), define_role: define });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getByRole('tab', { name: de.members.tab.roles }));
    await userEvent.click(screen.getByRole('button', { name: de.members.roles.define }));

    await userEvent.type(screen.getByLabelText(de.members.roles.name), 'Nur Zahlen');
    await userEvent.click(screen.getByLabelText(de.capability.pay));
    await userEvent.click(screen.getByRole('button', { name: de.members.roles.save }));

    await waitFor(() => expect(define).toHaveBeenCalledOnce());
    const sent = define.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', name: 'Nur Zahlen', capabilities: ['pay'] });
    expect('roleId' in sent).toBe(false);
    expect(typeof sent.idempotencyKey).toBe('string');
  });

  it('sends the roleId when an existing role is reshaped', async () => {
    const define = vi.fn<CannedHandler>(() => ok({ roleId: 'bookkeeper', capabilities: ['post'] }));
    withCapabilities({ ...baseCanned(), define_role: define });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getByRole('tab', { name: de.members.tab.roles }));
    await userEvent.click(screen.getAllByRole('button', { name: de.members.roles.edit })[0] as HTMLElement);

    // The editor opens pre-filled with the role's stored bundle, which is what makes the checkbox
    // grid an EDIT rather than a fresh definition that silently drops what was there.
    expect(screen.getByLabelText(de.capability.post)).toBeChecked();
    expect(screen.getByLabelText(de.capability.pay)).toBeChecked();
    expect(screen.getByLabelText(de.capability.manage_chart)).not.toBeChecked();

    await userEvent.click(screen.getByLabelText(de.capability.pay));
    await userEvent.click(screen.getByRole('button', { name: de.members.roles.save }));

    await waitFor(() => expect(define).toHaveBeenCalledOnce());
    expect(define.mock.calls[0][0]).toMatchObject({ roleId: 'bookkeeper', capabilities: ['post'] });
  });

  it('archives a custom role', async () => {
    const archive = vi.fn<CannedHandler>(() => ok({ roleId: 'role_9' }));
    withCapabilities({ ...baseCanned(), archive_role: archive });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getByRole('tab', { name: de.members.tab.roles }));
    await userEvent.click(screen.getByRole('button', { name: de.members.roles.archive }));
    await waitFor(() => expect(archive).toHaveBeenCalledOnce());
    expect(archive.mock.calls[0][0]).toMatchObject({ roleId: 'role_9' });
    expect(typeof archive.mock.calls[0][0].idempotencyKey).toBe('string');
  });
});

/**
 * D50: the MCP agent is a seated member, and the surface is where that stops being folklore.
 *
 * Provisioning seats BOTH D13 actors as owners, so the first invite no longer cuts `till mcp` out of
 * every write. The price the owner accepted is that whoever reaches the MCP socket holds everything
 * until somebody narrows it, and D50 asked for that price to be VISIBLE rather than hidden. Visible
 * means three things this block asserts separately, because each can be true without the others:
 * the agent is a row, the row is distinguishable from the Studio's own seat, and the screen says
 * what the row means while it still means it.
 */
describe('Members, the seated MCP agent (D50)', () => {
  const withAgent = (agentRole = 'owner') => ({
    ...baseCanned(),
    list_members: ok({ members: [OWNER_MEMBER, AGENT_MEMBER(agentRole), PENDING_MEMBER] }),
  });

  it('shows the agent as its own row, named apart from the Studio seat', async () => {
    withCapabilities(withAgent());
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(4);

    const agent = within(rows[2] as HTMLElement);
    expect(agent.getByText(de.members.actor.agent)).toBeInTheDocument();
    expect(agent.getByText('Sitzung: agent')).toBeInTheDocument();
    expect(agent.getByText(de.members.status.active)).toBeInTheDocument();

    // The two seats must not read as the same thing. This is the assertion that would have failed
    // before D50's labels, when both rendered the generic "this installation".
    const studio = within(rows[1] as HTMLElement);
    expect(studio.queryByText(de.members.actor.agent)).toBeNull();
    expect(agent.queryByText(de.members.actor.studio)).toBeNull();
  });

  it('says the agent holds everything, and stops saying it once the agent is narrowed', async () => {
    const { unmount } = withCapabilities(withAgent('owner'));
    await screen.findAllByRole('row');
    expect(await screen.findByText(de.members.agentIsOwner)).toBeInTheDocument();
    unmount();

    // A notice that outlives the condition it describes is furniture. Once the agent is a viewer,
    // there is nothing left to warn about and the screen goes quiet.
    withCapabilities(withAgent('viewer'));
    await screen.findAllByRole('row');
    expect(screen.queryByText(de.members.agentIsOwner)).toBeNull();
  });

  it('does not show the notice to somebody who could not act on it', async () => {
    // A warning an operator cannot act on is an accusation. A viewer has no `manage_members`, so no
    // role selector and no revoke button: telling them the agent is over-powered is noise.
    withCapabilities({ ...withAgent('owner'), whoami: whoamiViewer });
    await screen.findAllByRole('row');
    expect(screen.queryByText(de.members.agentIsOwner)).toBeNull();
  });

  it('offers the agent row the same role selector and revoke button as a person', async () => {
    // The whole repair rests on this: D50 replaced "invite the agent to a narrow role" with "narrow
    // the seat it already has", so the row has to be actionable or the notice is a dead end.
    const setRole = vi.fn<CannedHandler>(() => ok({ memberId: 'member_3', role: 'viewer' }));
    withCapabilities({ ...withAgent('owner'), set_role: setRole });
    const rows = await screen.findAllByRole('row');
    const agent = within(rows[2] as HTMLElement);

    expect(agent.getByRole('button', { name: de.members.revoke })).toBeInTheDocument();
    await userEvent.click(agent.getByRole('combobox', { name: de.members.roleLabel }));
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'viewer')!);
    await waitFor(() => expect(setRole).toHaveBeenCalledOnce());
    expect(setRole.mock.calls[0][0]).toMatchObject({ memberId: 'member_3', role: 'viewer' });
  });
});

/**
 * M03 invite (N4b): the S4.2 local-mode go-online notice and the S4.1 invite hand-over.
 *
 * The mode switch reads `whoami.identitySource` through the real CapabilitiesProvider: an absent
 * field is a laptop (`local_client`, the safe default the reader type documents), `served_subject`
 * is a proxy-attested session. The S4.2 acceptance is BOTH DIRECTIONS: notice present locally,
 * absent served, and the invite form stays enabled either way.
 */
describe('M03: the local-mode go-online notice (S4.2)', () => {
  it('renders the notice WITH the invite form in local mode, and the form is DISABLED with the notice as its reason', async () => {
    // Phase 2c (F-11): Phase 1 measured the local form minting a token the notice said nobody could
    // redeem. The engine cannot know the instance is local, so the Studio disables the form and
    // points the disabled controls at the notice (aria-describedby): the action that would fail is
    // disabled, never shown and then refused.
    const invite = vi.fn<CannedHandler>(() => ok({ memberId: 'member_3', token: 'invite_77', delivery: 'prepared' }));
    withCapabilities({ ...baseCanned(), invite_member: invite });
    await screen.findAllByRole('row');
    const notice = screen.getByRole('note');
    expect(notice.textContent).toContain(de.members.goOnline.notice);
    // One link, to the Hosting journey (the Operations surface), not a second invite path.
    expect(within(notice).getByRole('link', { name: de.members.goOnline.link })).toHaveAttribute(
      'href',
      '/operations',
    );
    expect(screen.getByLabelText('E-Mail')).toBeDisabled();
    const submit = screen.getByRole('button', { name: de.members.invite });
    expect(submit).toBeDisabled();
    const fieldset = submit.closest('fieldset') as HTMLFieldSetElement;
    expect(fieldset).toBeDisabled();
    const reason = document.getElementById(fieldset.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toContain(de.members.goOnline.notice);
    expect(invite).not.toHaveBeenCalled();
  });

  it('is ABSENT in served mode, where an invite is genuinely redeemable (the S4.2 acceptance)', async () => {
    const whoamiServed = ok({
      actor: 'member:user_1',
      provisioned: true,
      isMember: true,
      memberId: 'member_1',
      userId: 'user_1',
      role: 'owner',
      capabilities: ALL_CAPABILITIES,
      identitySource: 'served_subject',
      subject: 'dominic@example.ch',
    });
    withCapabilities({ ...baseCanned(), whoami: whoamiServed });
    await screen.findAllByRole('row');
    expect(screen.queryByRole('note')).toBeNull();
    // The form itself is unchanged: served mode is where inviting actually works.
    expect(screen.getByLabelText('E-Mail')).toBeEnabled();
  });

  it('is ABSENT for a viewer, because it belongs to the invite form and the viewer has none', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiViewer });
    await screen.findAllByRole('row');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('has no axe violations with the notice shown', async () => {
    const { container } = withCapabilities(baseCanned());
    await screen.findAllByRole('row');
    screen.getByRole('note');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('M03: the invite hand-over (S4.1)', () => {
  /** Replace the clipboard for one test. jsdom ships none, so this is a define, not an override. */
  function stubClipboard(clipboard: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  }

  afterEach(() => {
    stubClipboard(undefined);
  });

  it('renders the token, the redemption link with a copy control, and the no-mail sentence', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const invite = vi.fn<CannedHandler>(() => ok({ memberId: 'member_3', token: 'invite_77', delivery: 'prepared' }));
    withCapabilities({ ...baseCanned(), whoami: whoamiOwnerServed, invite_member: invite });
    await screen.findAllByRole('row');

    await userEvent.type(screen.getByLabelText('E-Mail'), 'neu@muster.ch');
    await userEvent.click(screen.getByRole('button', { name: de.members.invite }));
    await waitFor(() => expect(invite).toHaveBeenCalledOnce());

    // The sentence that TILL sends no mail: the owner hands the invite over (P8 outbound).
    expect(await screen.findByText(de.members.invited)).toBeInTheDocument();
    expect(screen.getByText('invite_77')).toBeInTheDocument();

    // The redemption link is the deep link the not-a-member page prefills from (never auto-redeems).
    // It carries the WORKSPACE (S4.3): a bare `/?invite=` link left a memberless subject on the
    // no-workspace shell, because the gate only resolves whoami once a workspace is selected.
    const link = `${window.location.origin}/w/ws_test/?invite=invite_77`;
    expect(screen.getByText(link)).toBeInTheDocument();

    // The copy control puts the EXACT link on the clipboard and confirms on the control itself.
    await userEvent.click(screen.getByRole('button', { name: de.members.copyLink }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(await screen.findByRole('button', { name: 'Kopiert' })).toBeInTheDocument();
  });
});

describe('Members, accessibility', () => {
  it('has no axe violations on the roster', async () => {
    const { container } = withCapabilities(baseCanned());
    await screen.findAllByRole('row');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Rollen tab with the editor open', async () => {
    const { container } = withCapabilities(baseCanned());
    await screen.findAllByRole('row');
    await userEvent.click(screen.getByRole('tab', { name: de.members.tab.roles }));
    await userEvent.click(screen.getByRole('button', { name: de.members.roles.define }));
    await screen.findByLabelText(de.members.roles.name);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Phase 2c (friction ledger F-11, M03 V5, D123): the kind field, the agent row in words, the revoke
 * confirm with the shared consequence sentence, and the re-invite feedback.
 */
describe('Members, Phase 2c: kind, confirm, re-invite', () => {
  it('KIND: choosing Agent renders kind agent into invite_member and explains the seat', async () => {
    const invite = vi.fn<CannedHandler>(() => ok({ memberId: 'member_3', token: 'invite_77', delivery: 'prepared', kind: 'agent' }));
    withCapabilities({ ...baseCanned(), whoami: whoamiOwnerServed, invite_member: invite });
    await screen.findAllByRole('row');
    const group = screen.getByRole('radiogroup', { name: de.members.kindLabel });
    expect(within(group).getByRole('radio', { name: de.members.kind.human })).toBeChecked();
    await userEvent.click(within(group).getByRole('radio', { name: de.members.kind.agent }));
    expect(screen.getByText(de.members.kindHint.agent)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('E-Mail'), 'claude@seeblick.example');
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === 'agent')!);
    await userEvent.click(screen.getByRole('button', { name: de.members.invite }));
    await waitFor(() => expect(invite).toHaveBeenCalledOnce());
    expect(invite.mock.calls[0][0]).toMatchObject({ email: 'claude@seeblick.example', role: 'agent', kind: 'agent' });
  });

  it('ROW: an agent member says so in words beside its name; a person carries no chip', async () => {
    const AGENT_MEMBER = { ...PENDING_MEMBER, memberId: 'member_9', userId: 'user_9', email: 'claude@seeblick.example', role: 'agent', kind: 'agent' as const };
    withCapabilities({ ...baseCanned(), list_members: ok({ members: [{ ...OWNER_MEMBER, kind: 'human' }, AGENT_MEMBER] }) });
    const rows = await screen.findAllByRole('row');
    expect((rows[2] as HTMLElement).querySelector('.members-kind-word')?.textContent).toBe(de.members.rowKind.agent);
    expect((rows[1] as HTMLElement).querySelector('.members-kind-word')).toBeNull();
  });

  it('CONFIRM: Zugriff entziehen opens an alertdialog naming the person and the shared consequence sentence; cancel revokes nothing', async () => {
    const revoke = vi.fn<CannedHandler>(() => ok({ memberId: 'member_2', revoked: true }));
    withCapabilities({ ...baseCanned(), revoke_member: revoke });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getAllByRole('button', { name: de.members.revoke })[1] as HTMLElement);
    const dialog = await screen.findByRole('alertdialog', { name: de.members.revokeConfirm.title });
    expect(dialog.textContent).toContain(de.members.revokeConfirm.body.replace('{name}', 'B. Halter'));
    expect(dialog.textContent).toContain('Entzieht einem Mitglied den Zugang zum Arbeitsbereich.');
    await userEvent.click(within(dialog).getByRole('button', { name: de.members.revokeConfirm.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(revoke).not.toHaveBeenCalled();
  });

  it('RE-INVITE: an invite that re-armed an expired row says so, and still hands the fresh code over', async () => {
    const invite = vi.fn<CannedHandler>(() => ok({ memberId: 'member_2', token: 'invite_78', delivery: 'prepared', replacedExpired: true }));
    withCapabilities({ ...baseCanned(), whoami: whoamiOwnerServed, invite_member: invite });
    await screen.findAllByRole('row');
    await userEvent.type(screen.getByLabelText('E-Mail'), 'buchhalter@muster.ch');
    await userEvent.click(screen.getByRole('button', { name: de.members.invite }));
    expect(await screen.findByText(de.members.reinvited)).toBeInTheDocument();
    expect(screen.getByText('invite_78')).toBeInTheDocument();
  });

  it('KIND MISMATCH: member_kind_mismatch renders in its own words', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiOwnerServed, invite_member: reject('member_kind_mismatch', { kind: 'human', requested: 'agent' }) });
    await screen.findAllByRole('row');
    await userEvent.type(screen.getByLabelText('E-Mail'), 'buchhalter@muster.ch');
    await userEvent.click(screen.getByRole('button', { name: de.members.invite }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(de.members.error.member_kind_mismatch);
  });

  it('has no axe violations with the confirm open and the kind field rendered', async () => {
    const { container } = withCapabilities({ ...baseCanned(), whoami: whoamiOwnerServed });
    await screen.findAllByRole('row');
    await userEvent.click(screen.getAllByRole('button', { name: de.members.revoke })[1] as HTMLElement);
    await screen.findByRole('alertdialog');
    expect(await axe(container)).toHaveNoViolations();
  });
});
