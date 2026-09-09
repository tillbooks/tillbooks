/**
 * The Anpassung surface: the human face of G00.
 *
 * WHAT THIS SUITE IS CAREFUL ABOUT. `useCapabilities()` FAILS OPEN by design
 * (`src/lib/capabilities.ts`): with no provider in the tree, or before `whoami` answers, `can()`
 * returns true and every control renders enabled. That default is correct for the product (the
 * engine is the gate; greying out a working ledger over a transient read failure is the more
 * expensive mistake) and it is a trap for a test, because a component test that forgets the
 * provider measures the permissive default and calls it a permission test. So every block below
 * that makes a claim about a GATE mounts a real `CapabilitiesProvider`.
 *
 * THE TWO CLAIMS WORTH THE MOST HERE ARE ABOUT DATA THAT MUST NOT VANISH.
 *
 *   A P8 DRAFT MUST BE VISIBLE AND RELEASABLE. A field an agent staged is invisible everywhere else
 *   in the product by construction, so if this screen does not show it, a human can never confirm it
 *   and the field is stranded for ever. That makes the draft banner a functional requirement rather
 *   than a nicety.
 *
 *   AN ARCHIVED FIELD MUST SAY THAT ITS VALUES SURVIVE. Archiving is a flag and there is no cascade
 *   anywhere in G00's schema, but an operator cannot read the schema. If the screen implies deletion,
 *   people will not archive, and they will ask for a delete instead.
 *
 * COPY IS ASSERTED THROUGH THE CATALOGUE, never as a literal typed here: a literal is a second copy
 * that drifts from the shipped one, and the de-CH `du` conversion (D56, which reverses D49) has just
 * rewritten them again.
 */
import { describe, it, expect } from 'vitest';
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
import Customization from './index';
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

const DEF = (over: Record<string, unknown> = {}) => ({
  fieldDefId: 'cfd_1',
  entityKind: 'contact',
  key: 'segment',
  labelI18n: { 'de-CH': 'Segment', en: 'Segment' },
  type: 'text',
  options: null,
  required: false,
  defaultValue: null,
  sort: 0,
  archived: false,
  draft: false,
  ...over,
});

const VIEW = (over: Record<string, unknown> = {}) => ({
  viewId: 'view_1',
  entityKind: 'contact',
  name: 'Grosskunden',
  shared: false,
  ownerActor: 'studio',
  filters: {},
  sort: [],
  columns: [],
  layout: 'table',
  isDefault: false,
  ...over,
});

const whoamiOwner = ok({
  actor: 'studio',
  role: 'owner',
  isMember: true,
  provisioned: true,
  capabilities: [
    'read_books',
    'read_sales',
    'read_master_data',
    'read_automations',
    'manage_master_data',
    'manage_custom_fields',
    'manage_saved_views',
  ],
});

/** A real viewer: every read domain but `read_members`, and no write at all. */
const whoamiViewer = ok({
  actor: 'agent',
  role: 'viewer',
  isMember: true,
  provisioned: true,
  capabilities: ['read_books', 'read_sales', 'read_master_data', 'read_vat', 'read_automations'],
});

/** Holds the FIELD capability and not the VIEW one, which is what separates the two gates. */
const whoamiFieldsOnly = ok({
  actor: 'agent',
  role: 'custom',
  isMember: true,
  provisioned: true,
  capabilities: ['read_books', 'read_sales', 'read_master_data', 'read_automations', 'manage_custom_fields'],
});

const baseCanned = (): Canned => ({
  whoami: whoamiOwner,
  list_field_defs: ok({ entityKind: 'contact', fieldDefs: [DEF()] }),
  list_saved_views: ok({ entityKind: 'contact', savedViews: [VIEW()] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Customization />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

/** Render WITHOUT a capabilities provider: only for states where permissions are not the subject. */
const renderCustomization = (canned: Canned, workspaceId: string | null = 'ws_test') =>
  render(tree(canned, workspaceId, false));

/** Render WITH the real provider, so `can()` answers from the canned `whoami` and not the default. */
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') =>
  render(tree(canned, workspaceId, true));

const openViews = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('tab', { name: de.customization.views.title }));

/**
 * Wait for the field list to have arrived.
 *
 * `findAllByText`, not `findByText`: the label appears TWICE on a loaded fields tab, once in the
 * list and once in the live `CustomFieldRow` preview the screen renders below it. That is the
 * surface working as designed, and a singular query reads it as a duplicate render.
 */
const loaded = () => screen.findAllByText('Segment');

describe('Customization, the load states', () => {
  it('shows a loading skeleton while the field defs are in flight', async () => {
    // The wait goes BEFORE the assertion: every surface initialises `loading` to true, so a skeleton
    // is the DEFAULT and not evidence that a read started.
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Customization />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('list_field_defs');
    const skeletons = screen.getAllByRole('status');
    expect(skeletons.length).toBeGreaterThan(1);
    for (const node of skeletons) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the error banner when the field list is refused', async () => {
    renderCustomization({ ...baseCanned(), list_field_defs: reject('permission_denied') });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('offers the empty state with no workspace open', async () => {
    renderCustomization(baseCanned(), null);
    expect(await screen.findByText(de.customization.noWorkspaceHint)).toBeInTheDocument();
  });

  it('names the ENTITY in its empty state, so the message is about what you are looking at', async () => {
    renderCustomization({ ...baseCanned(), list_field_defs: ok({ entityKind: 'contact', fieldDefs: [] }) });
    const expected = de.customization.fields.empty.replace('{entity}', de.customization.entity.contact);
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

describe('Customization, the entity picker', () => {
  it('offers every registered kind, each with a translated label', async () => {
    renderCustomization(baseCanned());
    const picker = (await screen.findByLabelText(de.customization.entityKind)) as HTMLSelectElement;
    const offered = within(picker).getAllByRole('option').map((o) => o.getAttribute('value'));
    // Compared against the catalogue's own key set: the labels and the picker cannot drift apart
    // without one of them going red, and a kind registered later owes a label here.
    expect(new Set(offered)).toEqual(new Set(Object.keys(de.customization.entity)));
    for (const value of offered) {
      expect(within(picker).getByRole('option', { name: (de.customization.entity as Record<string, string>)[value!] })).toBeInTheDocument();
    }
  });

  it('re-reads the engine for the newly chosen kind rather than filtering what it already had', async () => {
    const user = userEvent.setup();
    const asked: unknown[] = [];
    renderCustomization({
      ...baseCanned(),
      list_field_defs: (input) => {
        asked.push(input.entityKind);
        return ok({ entityKind: input.entityKind as string, fieldDefs: [] });
      },
    });
    await screen.findByLabelText(de.customization.entityKind);
    await user.selectOptions(screen.getByLabelText(de.customization.entityKind), 'journal_entry');
    await waitFor(() => expect(asked).toContain('journal_entry'));
  });

  it('asks for archived defs AND drafts explicitly, which is the only way either can appear', async () => {
    let asked: Record<string, unknown> | null = null;
    renderCustomization({
      ...baseCanned(),
      list_field_defs: (input) => {
        asked = input;
        return ok({ entityKind: 'contact', fieldDefs: [DEF()] });
      },
    });
    await loaded();
    expect(asked).not.toBeNull();
    expect(asked!.includeArchived).toBe(true);
    expect(asked!.includeDrafts).toBe(true);
  });
});

describe('Customization, the P8 draft gate', () => {
  it('shows an agent-staged field as a DRAFT and offers the release control', async () => {
    // A draft is invisible everywhere else in the product by construction. If this screen does not
    // show it, no human can ever confirm it and the field is stranded.
    withCapabilities({
      ...baseCanned(),
      list_field_defs: ok({ entityKind: 'contact', fieldDefs: [DEF({ draft: true })] }),
    });
    expect(await screen.findByText(de.customization.fields.draft_banner, { exact: false })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: de.customization.fields.confirm })).toBeInTheDocument();
  });

  it('really calls confirm_field with an idempotency key, and reloads', async () => {
    const user = userEvent.setup();
    const calls: Record<string, unknown>[] = [];
    withCapabilities({
      ...baseCanned(),
      list_field_defs: ok({ entityKind: 'contact', fieldDefs: [DEF({ draft: true })] }),
      confirm_field: (input) => {
        calls.push(input);
        return ok({ fieldDef: DEF(), confirmed: true });
      },
    });
    await user.click(await screen.findByRole('button', { name: de.customization.fields.confirm }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ workspaceId: 'ws_test', fieldDefId: 'cfd_1' });
    // §H-IDEMPOTENT: a retry with the same key never double-acts, so the key has to be sent at all.
    expect(typeof calls[0]!.idempotencyKey).toBe('string');
    expect(await screen.findByText(de.customization.fields.confirmed)).toBeInTheDocument();
  });

  it('withholds the release control from a viewer while still SHOWING the draft', async () => {
    // Both halves. A viewer needs to know a field is waiting even though they may not release it,
    // and hiding the banner would make the state unexplainable rather than merely unactionable.
    withCapabilities({
      ...baseCanned(),
      whoami: whoamiViewer,
      list_field_defs: ok({ entityKind: 'contact', fieldDefs: [DEF({ draft: true })] }),
    });
    expect(await screen.findByText(de.customization.fields.draft_banner, { exact: false })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: de.customization.fields.confirm })).toBeNull(),
    );
  });
});

describe('Customization, archiving says what it really does', () => {
  it('promises in words that the recorded values survive', async () => {
    // Archiving is a flag and there is no cascade in the schema, but an operator cannot read the
    // schema. If the screen implies deletion, people will ask for a delete instead.
    renderCustomization({
      ...baseCanned(),
      list_field_defs: ok({ entityKind: 'contact', fieldDefs: [DEF({ fieldDefId: 'cfd_2', archived: true })] }),
    });
    const title = de.customization.fields.archivedTitle.replace('{n}', '1');
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(de.customization.fields.archivedHint)).toBeInTheDocument();
  });

  it('keeps an archived field OUT of the live list and the preview', async () => {
    renderCustomization({
      ...baseCanned(),
      list_field_defs: ok({
        entityKind: 'contact',
        fieldDefs: [DEF(), DEF({ fieldDefId: 'cfd_2', key: 'alt', archived: true })],
      }),
    });
    await loaded();
    // The live list offers an archive control per field; the archived one is inside a `details` and
    // offers none, which is what stops it being acted on as though it were live.
    expect(screen.getAllByRole('button', { name: new RegExp(de.customization.fields.archive) })).toHaveLength(1);
  });

  it('warns, rather than refuses, when the archived field is still named by a saved view', async () => {
    // Refusing would strand the operator and destroying the reference would destroy someone else's
    // view. Honest degradation at the consumer is the P9 answer.
    const user = userEvent.setup();
    withCapabilities({
      ...baseCanned(),
      archive_field: ok({ fieldDef: DEF({ archived: true }), archived: true, referencingViews: 2 }),
    });
    await user.click(await screen.findByRole('button', { name: new RegExp(de.customization.fields.archive) }));
    expect(await screen.findByText(de.customization.warn.referenced.replace('{n}', '2'))).toBeInTheDocument();
  });

  it('says plainly that the values remain when nothing references the field', async () => {
    const user = userEvent.setup();
    withCapabilities({
      ...baseCanned(),
      archive_field: ok({ fieldDef: DEF({ archived: true }), archived: true, referencingViews: 0 }),
    });
    await user.click(await screen.findByRole('button', { name: new RegExp(de.customization.fields.archive) }));
    expect(await screen.findByText(de.customization.fields.archived)).toBeInTheDocument();
  });
});

describe('Customization, the two capability gates are separate', () => {
  it('withholds the field controls from a viewer', async () => {
    withCapabilities({ ...baseCanned(), whoami: whoamiViewer });
    await loaded();
    await waitFor(() => expect(screen.queryByRole('button', { name: de.customization.fields.create })).toBeNull());
    expect(screen.queryByRole('button', { name: new RegExp(de.customization.fields.archive) })).toBeNull();
  });

  it('offers the field controls to an actor holding manage_custom_fields', async () => {
    // Without this the assertion above would pass over a screen that shows no controls to anyone.
    withCapabilities({ ...baseCanned(), whoami: whoamiFieldsOnly });
    expect(await screen.findByRole('button', { name: de.customization.fields.create })).toBeInTheDocument();
  });

  it('offers deleting a PERSONAL view to its owner without manage_saved_views', async () => {
    // A personal view is a preference, so it needs only the read access the caller already has.
    const user = userEvent.setup();
    withCapabilities({ ...baseCanned(), whoami: whoamiFieldsOnly });
    await loaded();
    await openViews(user);
    expect(
      screen.getByRole('button', { name: `${de.customization.views.delete}: Grosskunden` }),
    ).toBeInTheDocument();
  });

  it('withholds deleting a SHARED view without manage_saved_views, and offers it with', async () => {
    // Publishing to the whole workspace is an administrative act, so unpublishing it is too. Both
    // directions are asserted, or the claim is "the button is never there".
    const user = userEvent.setup();
    const shared = ok({
      entityKind: 'contact',
      savedViews: [VIEW({ viewId: 'view_2', name: 'Team Ansicht', shared: true, ownerActor: null })],
    });

    const withoutIt = withCapabilities({ ...baseCanned(), whoami: whoamiFieldsOnly, list_saved_views: shared });
    await loaded();
    await openViews(user);
    // `getAllByText`: the name appears in the `SavedViewPicker` option AND in the list below it,
    // which is the surface working as designed rather than a duplicate render.
    expect(screen.getAllByText('Team Ansicht').length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: `${de.customization.views.delete}: Team Ansicht` }),
      ).toBeNull(),
    );
    withoutIt.unmount();

    withCapabilities({ ...baseCanned(), list_saved_views: shared });
    await loaded();
    await openViews(user);
    expect(
      await screen.findByRole('button', { name: `${de.customization.views.delete}: Team Ansicht` }),
    ).toBeInTheDocument();
  });

  it('renders the engine own rejection code on the panel that owns the input', async () => {
    const user = userEvent.setup();
    withCapabilities({ ...baseCanned(), archive_field: reject('permission_denied') });
    await user.click(await screen.findByRole('button', { name: new RegExp(de.customization.fields.archive) }));
    expect(await screen.findByText(de.customization.error.permission_denied)).toBeInTheDocument();
  });
});

describe('Customization, accessibility', () => {
  it('has no axe violations on the fields tab', async () => {
    const { container } = withCapabilities(baseCanned());
    await loaded();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the views tab', async () => {
    const user = userEvent.setup();
    const { container } = withCapabilities(baseCanned());
    await loaded();
    await openViews(user);
    expect(await axe(container)).toHaveNoViolations();
  });
});
