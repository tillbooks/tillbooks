/**
 * Contacts, the customer/vendor master-data surface (A09 §6), EXTENDED into C00's CRM spine.
 *
 * A09 shipped a searchable list with a role filter, a create/edit overlay and a soft archive. C00
 * deepens the SAME route rather than adding a screen (the bar for a new route is not met: contacts
 * already have a list surface). What it adds:
 *
 *   a kind filter (Firma / Person) and segment filter chips over `list_contacts`;
 *   a detail drawer with Stammdaten / Verlauf / Finanzen, the Verlauf tab being the OP5 timeline;
 *   multi-select plus a Zusammenführen toolbar action opening the survivor/diff modal;
 *   an Importieren toolbar action with the duplicate-review step.
 *
 * Still the five canonical states off the shared F1 primitives, and still no delete verb: master data
 * referenced by issued documents must survive, so archive remains the only removal (spec §6b, fixed).
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-23)
 *
 * The contact list is the shared `DataTable` (frame overflow, sticky header, density and the five
 * states in one place); the page header is `SurfaceHeader` and the search/filter row is `FilterBar`.
 * The detail view is the shared `DetailDrawer` (see `ContactDrawer.tsx`), the create/edit overlay a
 * `DetailDrawer` too (see `ContactEditor.tsx`), and the merge/import overlays are the shared `Modal`
 * (see `MergeModal.tsx` / `ImportModal.tsx`). The per-surface CSS that duplicated the list table, the
 * controls row, the page header and the drawer/modal scrims is gone; what remains in `Contacts.css`
 * is genuinely CRM-specific: the kind/role glyph cells, the segment/filter chips, the merge bulk bar,
 * the drawer tab strip, the timeline, the portal panels, the merge diff and the import review.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { useCan, CAP } from '../../lib/capabilities';
import {
  EmptyState,
  ErrorBanner,
  NoWorkspaceState,
  PermissionDenied,
  Skeleton,
} from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import type { Err } from '../../lib/client';
import { ContactEditor } from './ContactEditor';
import { ContactDrawer } from './ContactDrawer';
import { MergeModal } from './MergeModal';
import { ImportModal } from './ImportModal';
import { ArchiveGlyph, KindGlyph, NeedsAddressGlyph, QrReadyGlyph, RoleGlyph } from './glyphs';
import {
  CONTACT_KINDS,
  PARTY_ROLES,
  addressOf,
  allSegments,
  isQrReady,
  kindOf,
  matchesSearch,
  tagsOf,
  type Contact,
  type ContactKind,
  type PartyRole,
} from './model';

type EditorState = { mode: 'create' } | { mode: 'edit'; contact: Contact } | null;
type RoleFilter = PartyRole | 'all';
type KindFilter = ContactKind | 'all';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function Contacts() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  /**
   * THE PADLOCK, and the pattern is the one five shipped surfaces already keep: a write affordance the
   * actor cannot use is not rendered, rather than rendered and then refused by the engine
   * (`app/src/lib/capabilities.ts`, and Customization.tsx's `canManageFields ? … : null`).
   *
   * Since the F5 retrofit there are TWO booleans, because the engine gates two rights. The ordinary
   * writes (create, edit, archive, import) gate on `manage_master_data`. Merge is the elevated,
   * destructive-adjacent act and the engine requires BOTH `manage_master_data` AND `contacts.merge`
   * (the ALL-OF in `actionCapabilities.ts`), so the merge affordances, the selection checkboxes
   * included, render only when both are held: a checkbox whose only consumer is hidden selects for
   * nothing.
   *
   * `useCan` returns TRUE while `whoami` is unresolved, deliberately: this is a courtesy gate and the
   * engine is the real one. Failing closed here would grey out a working ledger over a transient read.
   */
  const canManage = useCan(CAP.manageMasterData);
  const canMergeContacts = useCan(CAP.contactsMerge) && canManage;

  const [contacts, setContacts] = useState<Contact[]>([]);
  // The currency the BOOKS are kept in (`workspace.base_currency`, via `get_company_profile`), which
  // is a SETTING and not a synonym for CHF. It preselects the currency for a NEW contact: the editor
  // sends `defaultCurrency` on every write, so a preselected CHF seeded francs into every contact a
  // EUR-based workspace created without touching the picker, and every document raised against that
  // party then inherited the wrong unit. `createContact` resolves an unnamed currency to
  // `baseCurrencyOf(ctx)`, and this is the GUI agreeing with it rather than overriding it.
  //
  // The initial value is the overwhelmingly common one and is replaced by the engine's answer, never
  // trusted over it. A failed profile read leaves it standing rather than blocking the list: the
  // contacts are the surface's job, and the engine still owns what a write records.
  const [baseCurrency, setBaseCurrency] = useState('CHF');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [segmentFilter, setSegmentFilter] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [editor, setEditor] = useState<EditorState>(null);
  const [detail, setDetail] = useState<Contact | null>(null);
  const [rowError, setRowError] = useState<Err | null>(null);

  // C00 merge (US-C00.4): the ids ticked for a merge. Exactly two are required, and the toolbar says
  // so inline rather than offering an action that refuses.
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const [resp, profileResp] = await Promise.all([
      client.call('list_contacts', {
        workspaceId,
        includeArchived: showArchived,
        partyRole: roleFilter === 'all' ? undefined : roleFilter,
        // The kind and segment filters are engine-side (`list_contacts` accepts both), so a segment
        // is a read model over the whole tenant rather than a filter over whatever this page loaded.
        kind: kindFilter === 'all' ? undefined : kindFilter,
        segment: segmentFilter ?? undefined,
      }),
      client.call('get_company_profile', { workspaceId }),
    ]);

    if (isErr(resp.body)) {
      if (resp.body.error === 'permission_denied' || resp.status === 403) {
        setDenied(true);
      } else {
        setError(resp.body);
      }
      setLoading(false);
      return;
    }

    setContacts(asArray<Contact>(resp.body.contacts));
    // The profile answers `{ok, profile: {...}}`: the wrapper, not the profile itself. Reading
    // `body.baseCurrency` here would be the assumed-shape bug family again (several Studio defects
    // have shipped from a key the engine never sent), so the value is taken one level down and only
    // when it is a real code.
    if (!isErr(profileResp.body)) {
      const profile = profileResp.body.profile as { baseCurrency?: string | null } | undefined;
      const base = profile?.baseCurrency ?? null;
      if (base !== null && base !== '') setBaseCurrency(base);
    }
    setLoading(false);
  }, [client, workspaceId, showArchived, roleFilter, kindFilter, segmentFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => contacts.filter((contact) => matchesSearch(contact, search)),
    [contacts, search],
  );

  // The chips offer the segments that actually exist on the loaded rows, so the filter can never
  // offer a segment nothing carries.
  const segments = useMemo(() => allSegments(contacts), [contacts]);

  const selectedContacts = useMemo(
    () =>
      selected
        .map((id) => contacts.find((c) => c.id === id))
        .filter((c): c is Contact => c !== undefined),
    [selected, contacts],
  );

  async function archiveContact(contact: Contact) {
    setRowError(null);
    const resp = await client.call('archive_contact', {
      workspaceId,
      contactId: contact.id,
    });
    if (isErr(resp.body)) setRowError(resp.body);
    else void load();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function afterMutation() {
    setSelected([]);
    setDetail(null);
    void load();
  }

  // The header is the one block every state shares, so it is rendered once here and reused by the
  // early returns below rather than copy-pasted into each of them (SurfaceHeader, D118 B2).
  const header = (actions?: ReactNode) => (
    <SurfaceHeader
      title={t('contact.title')}
      help={<SurfaceHelp surface="Contacts" />}
      actions={actions}
    />
  );

  // No workspace: a setup-first empty state, never a ctx call with a blank tenant.
  if (workspaceId === null) {
    return (
      <div className="contacts">
        {header()}
        <NoWorkspaceState body={t('contact.noWorkspaceHint')} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="contacts">
        {header()}
        <Skeleton rows={6} height={40} />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="contacts">
        {header()}
        <PermissionDenied />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="contacts">
        {header()}
        <ErrorBanner error={error} onRetry={() => void load()} />
      </div>
    );
  }

  const hasContacts = contacts.length > 0;
  const canMerge = selected.length === 2;

  const createButton = canManage ? (
    <>
      <button type="button" className="btn btn--secondary" onClick={() => setImporting(true)}>
        {t('contact.action.import')}
      </button>
      <button type="button" className="btn btn--primary" onClick={() => setEditor({ mode: 'create' })}>
        {t('contact.new')}
      </button>
    </>
  ) : undefined;

  // An empty FILTER result offers clear-filter, never a wall. The list has contacts; the filters are
  // what is hiding them, so the way out is to drop them. DataTable renders it when nothing matches.
  const noMatchState = (
    <EmptyState
      title={t('contact.noMatch')}
      hint={t('contact.noMatchHint')}
      action={{
        label: t('contact.clearSearch'),
        onClick: () => {
          setSearch('');
          setRoleFilter('all');
          setKindFilter('all');
          setSegmentFilter(null);
        },
      }}
    />
  );

  const columns: DataTableColumn<Contact>[] = [
    // The merge selection column. Present only when the actor holds the elevated pair, because the
    // checkbox feeds only the merge: a selection whose only consumer is hidden selects for nothing.
    ...(canMergeContacts
      ? [
          {
            key: 'select',
            header: t('contact.col.select'),
            headerHidden: true,
            width: '2.5rem',
            render: (c: Contact) => (
              <label className="ct-row-select">
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  onChange={() => toggleSelected(c.id)}
                />
                <span className="visually-hidden">{t('contact.merge.select', { name: c.name })}</span>
              </label>
            ),
          } satisfies DataTableColumn<Contact>,
        ]
      : []),
    {
      key: 'type',
      header: t('contact.col.type'),
      headerHidden: true,
      width: '4rem',
      // Role AND kind, glyph plus a screen-reader label: a party fact is never signalled by glyph or
      // colour alone (WCAG 2.2 AA). The `title` carries the same word for a pointer hover.
      render: (c) => {
        const kind = kindOf(c);
        return (
          <span className="ct-typecell">
            <span className="ct-role" title={t(`contact.role.${c.partyRole}`)}>
              <RoleGlyph role={c.partyRole} aria-hidden="true" />
              <span className="visually-hidden">{t(`contact.role.${c.partyRole}`)}</span>
            </span>
            <span className="ct-kind" title={t(`contact.kind.${kind}`)}>
              <KindGlyph kind={kind} aria-hidden="true" />
              <span className="visually-hidden">{t(`contact.kind.${kind}`)}</span>
            </span>
          </span>
        );
      },
    },
    {
      key: 'name',
      header: t('contact.name'),
      // The name opens the detail drawer: the row's primary affordance (D15/C2). It stays a real
      // button so a screen reader reaches it by name and the padlock has nothing to hide here (read).
      render: (c) => (
        <span className="ct-namecell">
          <button type="button" className="ct-name-btn" onClick={() => setDetail(c)}>
            {c.name}
          </button>
          {c.archived === true && (
            <span className="ct-archived-tag">
              <ArchiveGlyph />
              {t('contact.archived')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'city',
      header: t('contact.city'),
      render: (c) => {
        const city = addressOf(c as unknown as Record<string, unknown>).city ?? '';
        return <span className="ct-cell-dim">{city}</span>;
      },
    },
    {
      key: 'vat',
      header: t('contact.vatNumber'),
      // A VAT number is not money, so it left-aligns like text, but it reads with tabular figures so
      // the digit columns line up (the shared `.t-num` class).
      render: (c) => <span className="ct-cell-dim t-num">{c.vatNumber ?? ''}</span>,
    },
    {
      key: 'segments',
      header: t('contact.segmentsTitle'),
      render: (c) => {
        const segs = tagsOf(c, 'segments');
        if (segs.length === 0) return null;
        return (
          <span className="ct-row-segments">
            {segs.slice(0, 2).map((s) => (
              <span key={s} className="ct-chip ct-chip-sm">
                {s}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: 'qr',
      header: t('contact.col.qr'),
      render: (c) => {
        const qrReady = isQrReady(c);
        return (
          <span className={`ct-qr${qrReady ? ' ct-qr-ready' : ' ct-qr-missing'}`}>
            {qrReady ? <QrReadyGlyph /> : <NeedsAddressGlyph />}
            {qrReady ? t('contact.qrReady') : t('contact.needsStructuredAddress')}
          </span>
        );
      },
    },
    // D15/C2: the primary row action inline, the rest one level down. An archived row has nothing
    // left to offer, so it gets no overflow at all rather than a permanently dead one.
    ...(canManage
      ? [
          {
            key: 'actions',
            header: t('contact.col.actions'),
            headerHidden: true,
            align: 'end' as const,
            render: (c: Contact) => (
              <span className="ct-actions">
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditor({ mode: 'edit', contact: c })}>
                  {t('contact.edit')}
                </button>
                {c.archived !== true && (
                  <OverflowMenu
                    label={t('contact.rowActions', { name: c.name })}
                    items={[{ key: 'archive', label: t('contact.archive'), onSelect: () => void archiveContact(c) }]}
                  />
                )}
              </span>
            ),
          } satisfies DataTableColumn<Contact>,
        ]
      : []),
  ];

  return (
    <div className="contacts">
      {header(createButton)}

      {rowError !== null && <ErrorBanner error={rowError} />}

      {!hasContacts ? (
        <EmptyState
          title={t('contact.empty')}
          hint={t('contact.emptyHint')}
          /* The empty state's CTA is the same write: offering it to an actor who cannot create would
             be the shown-then-rejected shape on the one screen that has nothing else on it. */
          {...(canManage
            ? { action: { label: t('contact.new'), onClick: () => setEditor({ mode: 'create' }) } }
            : {})}
        />
      ) : (
        <>
          <FilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchLabel={t('contact.search')}
            searchPlaceholder={t('contact.search')}
            onClear={() => {
              setSearch('');
              setRoleFilter('all');
              setKindFilter('all');
              setSegmentFilter(null);
            }}
            clearLabel={t('contact.clearSearch')}
            active={
              search.trim() !== '' ||
              roleFilter !== 'all' ||
              kindFilter !== 'all' ||
              segmentFilter !== null
            }
          >
            <label className="ct-field-inline">
              <span className="visually-hidden">{t('contact.partyRole')}</span>
              <select
                className="field"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
              >
                <option value="all">{t('contact.roleFilter.all')}</option>
                {PARTY_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`contact.role.${role}`)}
                  </option>
                ))}
              </select>
            </label>
            {/* C00's kind axis, beside A09's role axis: the two are orthogonal facts about one row. */}
            <label className="ct-field-inline">
              <span className="visually-hidden">{t('contact.kindLabel')}</span>
              <select
                className="field"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as KindFilter)}
              >
                <option value="all">{t('contact.kindFilter.all')}</option>
                {CONTACT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`contact.kind.${kind}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="ct-checkbox">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              <span>{t('contact.showArchived')}</span>
            </label>
          </FilterBar>

          {/* Segment filter chips (US-C00.2). A pressed chip is the active filter; pressing it again
              clears it. `aria-pressed` carries the state, so it is never colour-only. */}
          {segments.length > 0 && (
            <div className="ct-chip-filters" role="group" aria-label={t('contact.segments.filter')}>
              {segments.map((segment) => {
                const active = segmentFilter === segment;
                return (
                  <button
                    key={segment}
                    type="button"
                    className={`ct-chip-btn${active ? ' ct-chip-btn-active' : ''}`}
                    aria-pressed={active}
                    onClick={() => setSegmentFilter(active ? null : segment)}
                  >
                    {segment}
                  </button>
                );
              })}
            </div>
          )}

          {/* The merge toolbar, present only once something is selected, so it never occupies space
              it has no use for. D15: the disabled action states its own precondition inline. Gated
              with the row checkboxes rather than separately: a selection whose only consumer is
              hidden is a dead end, and the canon forbids those. */}
          {canMergeContacts && selected.length > 0 && (
            <div className="ct-bulkbar" role="group" aria-label={t('contact.merge.toolbar')}>
              <span className="ct-bulk-count">
                {t('contact.merge.selected', { n: String(selected.length) })}
              </span>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={!canMerge}
                onClick={() => setMerging(true)}
              >
                {t('contact.action.merge')}
              </button>
              {!canMerge && <span className="ct-field-hint">{t('contact.merge.needTwo')}</span>}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected([])}>
                {t('contact.merge.clearSelection')}
              </button>
            </div>
          )}

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(c) => c.id}
            caption={t('contact.title')}
            emptyState={noMatchState}
            rowClassName={(c) =>
              [
                c.archived === true ? 'contacts-row--archived' : undefined,
                selected.includes(c.id) ? 'contacts-row--selected' : undefined,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
        </>
      )}

      {editor !== null && (
        <ContactEditor
          mode={editor.mode}
          workspaceId={workspaceId}
          contact={editor.mode === 'edit' ? editor.contact : undefined}
          contacts={contacts}
          baseCurrency={baseCurrency}
          onClose={() => setEditor(null)}
          onSaved={() => void load()}
        />
      )}

      {detail !== null && editor === null && (
        <ContactDrawer
          contact={detail}
          workspaceId={workspaceId}
          contacts={contacts}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditor({ mode: 'edit', contact: detail });
            setDetail(null);
          }}
          onChanged={afterMutation}
        />
      )}

      {merging && selectedContacts.length === 2 && (
        <MergeModal
          pair={[selectedContacts[0] as Contact, selectedContacts[1] as Contact]}
          workspaceId={workspaceId}
          onClose={() => setMerging(false)}
          onMerged={afterMutation}
        />
      )}

      {importing && (
        <ImportModal
          workspaceId={workspaceId}
          onClose={() => setImporting(false)}
          onImported={() => void load()}
        />
      )}
    </div>
  );
}
