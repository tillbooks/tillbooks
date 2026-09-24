/**
 * Items, the products/items master surface (D00 §6, extending A09's Stammdaten items half).
 *
 * Two tabs: the catalog (a category sidebar, a searchable list with variants indented under their
 * parent, an ItemEditor drawer for create/edit/variant, and per-row archive/restore/delete) and the
 * Preislisten tab (D00 US-D00.4). Renders the five canonical states off the shared F1 primitives.
 * Prices render through the P11 formatMoney helper; a row carries integer Rappen, never a float (P2).
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-23)
 *
 * This is the first surface to adopt the D118 B2 primitive foundation, so most of what used to be
 * hand-rolled here (and its per-surface CSS) is gone in favour of the shared components:
 *
 *   - the catalog list is the shared `DataTable` (frame overflow, sticky header, density and the
 *     five states in one place), instead of a bespoke `<ul>` of flex rows;
 *   - the create/edit overlay is the shared `DetailDrawer` (see `ItemEditor.tsx`);
 *   - the page header is the shared `SurfaceHeader`, the search/filter row the shared `FilterBar`,
 *     and the Katalog/Preislisten switch the shared WAI-ARIA `Tabs` (the strip used to be
 *     `aria-pressed` toggle buttons, which the Tabs primitive replaces with a real tablist).
 *
 * The Tabs panels keep the surface's lazy behaviour: a tab's panel content is rendered only while it
 * is the active tab, so switching to Preislisten unmounts the catalog (its search really goes away,
 * not merely hidden) and PriceLists reads nothing until it is opened.
 *
 * Archive is a soft flag; delete is the hard-delete fenced by the engine's reference census.
 *
 * ## ROUND 2 (D137)
 *
 * The row opens the editor (K-21) and every other verb (Variante, Archivieren, Löschen) sits behind
 * the one trailing overflow. The tax column shows the short rate ("8.1%") with the code's full name
 * in a real tooltip (K-19): the three-line pill used to drive the row to 80px and push the table past
 * its frame. The category list is a list of rows, the current one marked with `aria-current` and the
 * pill (K-11, K-22), and an archived item says so as a `Status` word in dim ink (K-22, K-36).
 *
 * ## THE HARD DELETE ASKS FIRST, AND A REFUSAL SAYS WHAT AND OFFERS THE ALTERNATIVE (2026-07-30)
 *
 * `delete_item` used to fire straight off the overflow menu: the Studio's ONLY one-click irreversible
 * destructive action, on a surface where every neighbour (`Accounts`, `DocumentEditor`) already gated
 * its own behind a `ConfirmDialog`. It is gated now, and the menu item carries `danger` like every
 * other destructive item in the app.
 *
 * The refusal path mattered more. The engine returns `refs` precisely so the surface can NAME what
 * still points at the item, and `deleteItem`'s docblock says the caller offers archive instead;
 * neither reached the screen. Worse, `errors.item_referenced` had no message at all, and `ErrorBanner`
 * treats an unmapped code as `reportable` (D48), so a correct, deliberate refusal by a working fence
 * invited the operator to file a bug report about it. Now the banner names the reference kinds and the
 * archive alternative sits beside it.
 *
 * ## THE CATEGORY TREE IS BUILT HERE, NOT ONLY RENDERED (2026-07-30)
 *
 * `item_categories_upsert` was only ever called as `{ workspaceId, name }`, so the Studio could create
 * ROOT categories and nothing else: no child, no rename, no re-file. `item_categories_delete` had zero
 * callers in the whole app. A verb that is built, registered and tested but that no surface can reach
 * is missing functionality rather than missing polish, so the sidebar now carries the whole two-level
 * tree: a child under a root, a rename, and a delete behind a confirm whose refusal (`category_in_use`)
 * explains itself.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney } from '../../i18n';
import {
  EmptyState,
  ErrorBanner,
  NoWorkspaceState,
  PermissionDenied,
  useSkeletonHold,
} from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterBar } from '../../components/FilterBar';
import { Tabs } from '../../components/Tabs';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { Tooltip } from '../../components/Tooltip';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { useCan, CAP } from '../../lib/capabilities';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import type { Err } from '../../lib/client';
import { ItemEditor } from './ItemEditor';
import { PriceLists } from './PriceLists';
import {
  ITEM_UNITS,
  categoryTree,
  idemKey,
  matchesSearch,
  type Account,
  type Category,
  type Item,
  type VatCode,
} from './model';

type DrawerState =
  | { mode: 'create' }
  | { mode: 'variant'; parent: Item }
  | { mode: 'edit'; item: Item }
  | null;

/**
 * A pending destructive act, held until the operator confirms it.
 *
 * One state for both kinds rather than two booleans: only one confirm can be open at a time, and a
 * shape that cannot represent two open dialogs is the cheapest way to keep it that way.
 */
type Pending = { kind: 'item'; item: Item } | { kind: 'category'; category: Category } | null;

/**
 * A pending category name entry, held until the operator confirms it in the in-app dialog.
 *
 * Category create and rename used the native `window.prompt`, the only two calls of it left on this
 * surface: unstyled, non-theme-aware browser chrome with no inline validation, and silently inert in
 * webviews that suppress `window.prompt`. This state drives the themed `CategoryDialog` instead, so
 * naming a category stays inside the app with real validation, exactly like every other create flow
 * here.
 */
type CategoryPrompt =
  | { mode: 'create'; parent?: Category }
  | { mode: 'rename'; category: Category }
  | null;

/**
 * A row-level rejection, together with the item it was about.
 *
 * The item travels with the error because `item_referenced` has an ALTERNATIVE (archive this same
 * item), and an error object alone cannot say which row to offer it for.
 */
type RowError = { err: Err; item?: Item } | null;

type Tab = 'items' | 'pricelists';

/** One catalog row: an item and whether it renders indented as a variant under its parent. */
type Row = { item: Item; isVariant: boolean };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * A tax code's short form for the catalog cell (K-19): its rate ("8.1%", "0%"), read off the engine's
 * integer basis points, else the first rate written in its label, else the code itself. The full name
 * stays one hover or focus away, in the tooltip.
 */
export function shortTaxCode(vat: VatCode | undefined, code: string): string {
  if (vat !== undefined && typeof vat.rateBp === 'number' && Number.isFinite(vat.rateBp)) {
    return `${vat.rateBp / 100}%`;
  }
  const written = vat?.label.match(/\d+(?:[.,]\d+)?\s?%/);
  return written !== undefined && written !== null ? written[0].replace(/\s/, '') : code;
}

export function Items() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  /**
   * THE PADLOCK (A24, F5 retrofit). Every write on this surface, the D00 categories and price lists
   * included, is `manage_master_data`, so every write affordance is ABSENT for an actor the engine
   * would refuse (the Contacts idiom). `useCan` fails open while `whoami` is unresolved: the
   * engine's `ctxAction` gate is the one that decides.
   */
  const canManage = useCan(CAP.manageMasterData);

  const [tab, setTab] = useState<Tab>('items');

  const [items, setItems] = useState<Item[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vatCodes, setVatCodes] = useState<VatCode[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [baseCurrency, setBaseCurrency] = useState('CHF');

  const [loading, setLoading] = useState(true);
  // K-34: the table's own skeleton, never before 200ms and never for less than 300ms once shown.
  const showSkeleton = useSkeletonHold(loading);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [rowError, setRowError] = useState<RowError>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [categoryPrompt, setCategoryPrompt] = useState<CategoryPrompt>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const [itemsResp, accountsResp, vatResp, profileResp, categoriesResp] = await Promise.all([
      client.call('list_items', { workspaceId, includeArchived: showArchived }),
      client.call('list_accounts', { workspaceId }),
      client.call('vat_codes', { workspaceId }),
      client.call('get_company_profile', { workspaceId }),
      client.call('item_categories_list', { workspaceId }),
    ]);

    if (isErr(itemsResp.body)) {
      if (itemsResp.body.error === 'permission_denied' || itemsResp.status === 403) setDenied(true);
      else setError(itemsResp.body);
      setLoading(false);
      return;
    }

    setItems(asArray<Item>(itemsResp.body.items));
    setAccounts(isErr(accountsResp.body) ? [] : asArray<Account>(accountsResp.body.accounts));
    setVatCodes(isErr(vatResp.body) ? [] : asArray<VatCode>(vatResp.body.taxCodes));
    // Categories are additive: a workspace with none, or an engine that has not shipped the read yet,
    // simply shows "Alle Artikel" and no sidebar entries.
    setCategories(isErr(categoriesResp.body) ? [] : asArray<Category>(categoriesResp.body.categories));
    if (!isErr(profileResp.body)) {
      const profile = profileResp.body.profile as { baseCurrency?: string | null } | undefined;
      const base = profile?.baseCurrency ?? null;
      if (base !== null && base !== '') setBaseCurrency(base);
    }
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  // Variants indented under their parent: parents (and un-varianted items) first, each followed by its
  // variants. Category and search filters apply to the parent set; a variant follows its shown parent.
  const rows = useMemo<Row[]>(() => {
    const inCategory = (item: Item): boolean =>
      categoryFilter === null || item.categoryId === categoryFilter;
    const visibleParents = items
      .filter((item) => item.variantOfId === undefined || item.variantOfId === null)
      .filter((item) => matchesSearch(item, search, unitLabel) && inCategory(item))
      .sort((a, b) => a.name.localeCompare(b.name));
    const out: Row[] = [];
    for (const parent of visibleParents) {
      out.push({ item: parent, isVariant: false });
      for (const variant of items
        .filter((i) => i.variantOfId === parent.id)
        .sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ item: variant, isVariant: true });
      }
    }
    return out;
    // `t` is in the deps because `unitLabel` closes over it and the search now matches the LABEL: a
    // locale switch has to re-filter, or the rows keep answering to the previous language's words.
  }, [items, search, categoryFilter, t]);

  const vatByCode = useMemo(() => {
    const map = new Map<string, VatCode>();
    for (const code of vatCodes) map.set(code.code, code);
    return map;
  }, [vatCodes]);

  /**
   * The label a row PRINTS for a unit, which is what a search has to match.
   *
   * A09 stored `unit` as free text and D00 narrowed it to the ITEM_UNITS enum, so the stored value is
   * `hour` while the row reads `Stunde`. `matchesSearch` matched the stored code only, so typing what
   * was on screen returned nothing. It now takes this resolver and matches both.
   */
  function unitLabel(unit: string): string {
    return (ITEM_UNITS as readonly string[]).includes(unit) ? t(`item.unit.${unit}`) : unit;
  }

  async function archive(item: Item) {
    setRowError(null);
    const resp = await client.call('archive_item', { workspaceId, itemId: item.id });
    if (isErr(resp.body)) setRowError({ err: resp.body, item });
    else void load();
  }

  async function unarchive(item: Item) {
    setRowError(null);
    const resp = await client.call('unarchive_item', { workspaceId, itemId: item.id });
    if (isErr(resp.body)) setRowError({ err: resp.body, item });
    else void load();
  }

  async function remove(item: Item) {
    setRowError(null);
    setPending(null);
    const resp = await client.call('delete_item', { workspaceId, itemId: item.id, idempotencyKey: `del-${item.id}` });
    if (isErr(resp.body)) setRowError({ err: resp.body, item });
    else void load();
  }

  async function upsertCategory(input: { categoryId?: string; name: string; parentId?: string }) {
    setRowError(null);
    const resp = await client.call('item_categories_upsert', {
      workspaceId,
      ...input,
      idempotencyKey: idemKey('cat'),
    });
    if (isErr(resp.body)) setRowError({ err: resp.body });
    else void load();
  }

  // Create and rename open the in-app dialog rather than `window.prompt`; the write happens on the
  // dialog's confirm (see `confirmCategoryPrompt`), which carries the trimmed, validated name.
  function createCategory(parent?: Category) {
    setRowError(null);
    setCategoryPrompt({ mode: 'create', parent });
  }

  function renameCategory(category: Category) {
    setRowError(null);
    setCategoryPrompt({ mode: 'rename', category });
  }

  /** The dialog confirmed with a non-empty, already-trimmed `name`. */
  function confirmCategoryPrompt(name: string) {
    if (categoryPrompt === null) return;
    if (categoryPrompt.mode === 'create') {
      const parent = categoryPrompt.parent;
      void upsertCategory(parent === undefined ? { name } : { name, parentId: parent.id });
    } else if (name !== categoryPrompt.category.name) {
      // A rename to the unchanged name is a no-op, exactly as the prompt version treated it.
      void upsertCategory({ categoryId: categoryPrompt.category.id, name });
    }
    setCategoryPrompt(null);
  }

  async function removeCategory(category: Category) {
    setRowError(null);
    setPending(null);
    const resp = await client.call('item_categories_delete', {
      workspaceId,
      categoryId: category.id,
      idempotencyKey: idemKey('catdel'),
    });
    if (isErr(resp.body)) {
      setRowError({ err: resp.body });
      return;
    }
    // A filter pointing at a category that no longer exists would show an empty catalog with no way
    // back that reads as an explanation, so the filter goes back to "Alle Artikel" with it.
    if (categoryFilter === category.id) setCategoryFilter(null);
    void load();
  }

  // The header is the one block every state shares, so it is rendered once here and reused by the
  // early returns below rather than copy-pasted into each of them (SurfaceHeader, D118 B2).
  const header = (actions?: ReactNode) => (
    <SurfaceHeader title={t('item.title')} help={<SurfaceHelp surface="Items" />} actions={actions} />
  );

  if (workspaceId === null) {
    return (
      <div className="items">
        {header()}
        <NoWorkspaceState body={t('item.noWorkspaceHint')} />
      </div>
    );
  }

  if (showSkeleton) {
    return (
      <div className="items">
        {header()}
        <DataTable columns={[]} rows={[]} rowKey={() => ''} loading skeletonRows={6} />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="items">
        {header()}
        <PermissionDenied />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="items">
        {header()}
        <ErrorBanner error={error} onRetry={() => void load()} context="read" />
      </div>
    );
  }

  const hasItems = items.length > 0;
  const tree = categoryTree(categories);

  // The empty state is two distinct facts: a workspace with no items at all invites the first create,
  // while a filter or search that hides every row offers a way back. DataTable renders whichever this
  // resolves to when it has no rows.
  const emptyState = !hasItems ? (
    <EmptyState
      title={t('item.empty')}
      hint={t('item.emptyHint')}
      {...(canManage
        ? { action: { label: t('item.new'), onClick: () => setDrawer({ mode: 'create' }) } }
        : {})}
    />
  ) : (
    <EmptyState
      title={showArchived ? t('item.emptyArchived') : t('item.emptySearch')}
      hint={t('item.emptySearchHint')}
      filtered={{ onClear: () => setSearch(''), clearLabel: t('item.clearSearch') }}
    />
  );

  const columns: DataTableColumn<Row>[] = [
    {
      key: 'name',
      header: t('item.col.name'),
      render: ({ item, isVariant }) => {
        const archived = item.archived === true;
        const sku = item.sku;
        return (
          <span className="item-name-cell">
            <span
              className={`item-name${isVariant ? ' item-name--variant' : ''}${archived ? ' item-name--muted' : ''}`}
            >
              {sku !== undefined && sku !== null && sku !== '' && <span className="item-sku">{sku}</span>}
              {item.name}
            </span>
            {archived && <Status kind="inactive" label={t('item.archived')} />}
          </span>
        );
      },
    },
    {
      key: 'price',
      header: t('item.col.price'),
      numeric: true,
      render: ({ item }) => (
        <span className={item.archived === true ? 'item-name--muted' : undefined}>
          {formatMoney(item.defaultUnitPriceMinor, item.currency ?? baseCurrency)}
        </span>
      ),
    },
    {
      key: 'taxCode',
      header: t('item.col.taxCode'),
      // K-19: the short rate ("8.1%") in the cell and the code's full name in a real tooltip. The
      // full name used to wrap to three lines and drive the whole row to 80px.
      render: ({ item }) => {
        const taxCode = item.defaultTaxCode ?? undefined;
        if (taxCode === undefined) return null;
        const vat = vatByCode.get(taxCode);
        return (
          <Tooltip content={vat?.label ?? taxCode}>
            <span className="item-tax">{shortTaxCode(vat, taxCode)}</span>
          </Tooltip>
        );
      },
    },
    {
      key: 'category',
      header: t('item.col.category'),
      render: ({ item }) => {
        const category =
          item.categoryId !== undefined && item.categoryId !== null
            ? categoryName.get(item.categoryId)
            : undefined;
        return category !== undefined ? <span className="item-unit">{category}</span> : null;
      },
    },
    {
      key: 'unit',
      header: t('item.col.unit'),
      render: ({ item }) =>
        item.unit !== undefined && item.unit !== null && item.unit !== '' ? (
          <span className="item-unit">{unitLabel(item.unit)}</span>
        ) : null,
    },
  ];

  // K-21: the row opens the editor; every other verb sits behind ONE overflow, destructive last and
  // marked `danger`, like every other caller in the Studio (D15/C2). Without the right, the row opens
  // nothing and there is no overflow: the padlock hides writes rather than refusing them.
  const itemActions = (item: Item) =>
    item.archived === true
      ? [
          { key: 'unarchive', label: t('item.unarchive'), onSelect: () => void unarchive(item) },
          { key: 'delete', label: t('item.delete'), onSelect: () => setPending({ kind: 'item', item }), danger: true },
        ]
      : [
          { key: 'variant', label: t('item.action.create_variant'), onSelect: () => setDrawer({ mode: 'variant', parent: item }) },
          { key: 'archive', label: t('item.archive'), onSelect: () => void archive(item) },
          { key: 'delete', label: t('item.delete'), onSelect: () => setPending({ kind: 'item', item }), danger: true },
        ];

  const catalogPanel = (
    <div className="items-layout">
      <nav className="items-sidebar panel" aria-label={t('item.categories')}>
        <button
          type="button"
          className={`items-cat${categoryFilter === null ? ' items-cat--active' : ''}`}
          aria-current={categoryFilter === null ? 'true' : undefined}
          onClick={() => setCategoryFilter(null)}
        >
          {t('item.allItems')}
        </button>
        {tree.map(({ root, children }) => (
          <div key={root.id}>
            <CategoryEntry
              category={root}
              isChild={false}
              canManage={canManage}
              active={categoryFilter === root.id}
              onSelect={() => setCategoryFilter(root.id)}
              onAddChild={() => void createCategory(root)}
              onRename={() => void renameCategory(root)}
              onDelete={() => setPending({ kind: 'category', category: root })}
            />
            {children.map((child) => (
              <CategoryEntry
                key={child.id}
                category={child}
                isChild
                canManage={canManage}
                active={categoryFilter === child.id}
                onSelect={() => setCategoryFilter(child.id)}
                onRename={() => void renameCategory(child)}
                onDelete={() => setPending({ kind: 'category', category: child })}
              />
            ))}
          </div>
        ))}
        {canManage && (
          <button type="button" className="btn btn--ghost btn--sm items-cat-add" onClick={() => void createCategory()}>
            {t('item.newCategory')}
          </button>
        )}
      </nav>

      <div className="items-main">
        <FilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchLabel={t('item.search')}
          searchPlaceholder={t('item.search')}
        >
          <label className="item-checkbox">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            <span>{t('item.showArchived')}</span>
          </label>
        </FilterBar>

        {rowError !== null && <RowErrorBanner rowError={rowError} onArchive={archive} />}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={({ item }) => item.id}
          caption={t('item.tableCaption')}
          emptyState={emptyState}
          onRowClick={canManage ? ({ item }) => setDrawer({ mode: 'edit', item }) : undefined}
          rowLabel={({ item }) => item.name}
          rowActions={canManage ? ({ item }) => itemActions(item) : undefined}
          rowActionsLabel={({ item }) => t('item.rowActions', { name: item.name })}
        />
      </div>
    </div>
  );

  return (
    <div className="items">
      {header(
        tab === 'items' && canManage ? (
          <button type="button" className="btn btn--primary" onClick={() => setDrawer({ mode: 'create' })}>
            {t('item.new')}
          </button>
        ) : undefined,
      )}

      <Tabs
        label={t('item.tabsLabel')}
        activeId={tab}
        onChange={(id) => setTab(id as Tab)}
        tabs={[
          {
            id: 'items',
            label: t('item.tab.catalog'),
            // Rendered only while active, so switching away unmounts the catalog (its search really
            // goes away, not merely hidden) rather than leaving it behind the Tabs panel.
            panel: tab === 'items' ? catalogPanel : null,
          },
          {
            id: 'pricelists',
            label: t('pricelists.tab.title'),
            // Lazy for the same reason and because PriceLists reads on mount: it asks for nothing
            // until the operator opens the tab.
            panel:
              tab === 'pricelists' ? (
                <PriceLists workspaceId={workspaceId} items={items} baseCurrency={baseCurrency} canManage={canManage} />
              ) : null,
          },
        ]}
      />

      {drawer !== null && (
        <ItemEditor
          mode={drawer.mode === 'edit' ? 'edit' : 'create'}
          workspaceId={workspaceId}
          accounts={accounts}
          vatCodes={vatCodes}
          categories={categories}
          item={drawer.mode === 'edit' ? drawer.item : undefined}
          variantOf={drawer.mode === 'variant' ? drawer.parent : undefined}
          baseCurrency={baseCurrency}
          onClose={() => setDrawer(null)}
          onSaved={() => void load()}
        />
      )}

      {pending !== null && pending.kind === 'item' && (
        <ConfirmDialog
          message={t('item.confirmDelete', { name: pending.item.name })}
          confirmLabel={t('item.confirmDeleteConfirm')}
          cancelLabel={t('item.cancel')}
          onConfirm={() => void remove(pending.item)}
          onCancel={() => setPending(null)}
        />
      )}

      {pending !== null && pending.kind === 'category' && (
        <ConfirmDialog
          message={t('item.confirmDeleteCategory', { name: pending.category.name })}
          confirmLabel={t('item.confirmDeleteCategoryConfirm')}
          cancelLabel={t('item.cancel')}
          onConfirm={() => void removeCategory(pending.category)}
          onCancel={() => setPending(null)}
        />
      )}

      {categoryPrompt !== null && (
        <CategoryDialog
          title={
            categoryPrompt.mode === 'create'
              ? categoryPrompt.parent === undefined
                ? t('item.categoryNamePrompt')
                : t('item.categoryChildPrompt', { name: categoryPrompt.parent.name })
              : t('item.categoryRenamePrompt', { name: categoryPrompt.category.name })
          }
          initialValue={categoryPrompt.mode === 'rename' ? categoryPrompt.category.name : ''}
          onConfirm={confirmCategoryPrompt}
          onCancel={() => setCategoryPrompt(null)}
        />
      )}
    </div>
  );
}

interface CategoryDialogProps {
  /** The already-resolved prompt copy, reused verbatim from the former `window.prompt` message. */
  title: string;
  /** Prefill (the current name on rename, empty on create). */
  initialValue: string;
  /** Called with the trimmed, non-empty name. */
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/**
 * The in-app replacement for `window.prompt` on category create/rename: a small themed text-field
 * dialog with confirm/cancel and inline validation, Items-local by design (D46: a broad shared
 * primitive would owe separate design review). It mirrors the surface's `ConfirmDialog` shell, so
 * the dialog role sits on a `div` (the modal-role guard forbids it on `aside`/`form`), and the field
 * takes focus on open. An empty name is refused inline rather than silently dropped.
 */
function CategoryDialog({ title, initialValue, onConfirm, onCancel }: CategoryDialogProps) {
  const t = useT();
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const invalid = trimmed === '';

  const submit = () => {
    if (invalid) {
      setTouched(true);
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div className="items-cat-dialog-overlay" role="presentation" onClick={onCancel}>
      <div
        className="items-cat-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label id={titleId} htmlFor={inputId} className="items-cat-dialog-title">
            {title}
          </label>
          <input
            id={inputId}
            type="text"
            className="field"
            value={value}
            autoFocus
            onChange={(event) => {
              setValue(event.target.value);
              if (touched) setTouched(false);
            }}
            aria-invalid={touched && invalid}
            aria-describedby={touched && invalid ? errorId : undefined}
          />
          {touched && invalid && (
            <p id={errorId} className="field-error" role="alert">
              {t('item.categoryNameRequired')}
            </p>
          )}
          <div className="items-cat-dialog-foot">
            <button type="button" className="btn btn--secondary" onClick={onCancel}>
              {t('item.cancel')}
            </button>
            <button type="submit" className="btn btn--primary">
              {t('item.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * One row-level rejection, with the alternative the engine's own payload implies.
 *
 * `item_referenced` is the case this exists for: the engine sends `refs` so the surface can name what
 * still points at the item, and archive is the documented way forward. Passing `message` rather than
 * letting `ErrorBanner` map the code also keeps the banner from classifying a deliberate, correct
 * refusal as `reportable` (D48): a working fence must not offer to be reported as a defect.
 */
function RowErrorBanner({ rowError, onArchive }: { rowError: NonNullable<RowError>; onArchive: (item: Item) => void }) {
  const t = useT();
  const { err, item } = rowError;
  if (err.error !== 'item_referenced') return <ErrorBanner error={err} />;

  const refs = Array.isArray(err.refs) ? (err.refs as string[]) : [];
  const named = refs.map((ref) => t(`item.ref.${ref}`)).join(', ');
  const message =
    refs.length > 0
      ? `${t('errors.item_referenced')} ${t('item.referencedBy', { refs: named })}`
      : t('errors.item_referenced');

  return (
    <>
      <ErrorBanner error={err} message={message} />
      {item !== undefined && item.archived !== true && (
        <button type="button" className="btn btn--secondary" onClick={() => onArchive(item)}>
          {t('item.archiveInstead')}
        </button>
      )}
    </>
  );
}

interface CategoryEntryProps {
  category: Category;
  isChild: boolean;
  /** A24 `manage_master_data` (F5): the maintenance menu is absent without it; the filter stays. */
  canManage: boolean;
  active: boolean;
  onSelect: () => void;
  /** Only a ROOT may take a child: the tree is exactly two levels (spec §6b, a fixed invariant). */
  onAddChild?: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * One category in the sidebar: the filter, plus the actions that maintain it.
 *
 * The filter and the menu are siblings rather than one nested inside the other, because a button
 * inside a button is not valid HTML and the menu trigger IS a button.
 */
function CategoryEntry({ category, isChild, canManage, active, onSelect, onAddChild, onRename, onDelete }: CategoryEntryProps) {
  const t = useT();
  const actions = [
    ...(onAddChild !== undefined
      ? [{ key: 'child', label: t('item.categoryNewChild'), onSelect: onAddChild }]
      : []),
    { key: 'rename', label: t('item.categoryRename'), onSelect: onRename },
    // Destructive last, and coloured only once the menu is open (D15/C2).
    { key: 'delete', label: t('item.categoryDelete'), onSelect: onDelete, danger: true },
  ];
  return (
    <div className="items-cat-entry">
      <button
        type="button"
        className={`items-cat${isChild ? ' items-cat--child' : ''}${active ? ' items-cat--active' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
      >
        {category.name}
      </button>
      {canManage && (
        <OverflowMenu quiet label={t('item.categoryActions', { name: category.name })} items={actions} />
      )}
    </div>
  );
}
