/**
 * D00, the products/items master: the additions `Items.tsx` and `ItemEditor.tsx` grew, and nothing held.
 *
 * A09 shipped an item as a name, a price, a currency, a VAT code and a revenue account, and
 * `Items.test.tsx` covers that. D00 then added the category tree, variants, the article number, the
 * kind and unit enums, the stock dials and the hard delete fenced by a reference census, and edited
 * that suite only lightly. This file covers the additions.
 *
 * WHY A SECOND FILE RATHER THAN A LONGER FIRST ONE. `Items.test.tsx`'s `happyCanned()` deliberately
 * answers 404 for `item_categories_list` and `get_company_profile`, which is what makes its
 * degradation assertions mean something. Every test below needs the opposite: a workspace that really
 * has a category tree. Widening the shared fixture would have quietly changed what the existing
 * assertions prove. `Items.base-currency.test.tsx` is the same precedent.
 *
 * THE ENUMS ARE COMPARED TO THE MIRROR, NOT RETYPED. `ITEM_KINDS` and `ITEM_UNITS` come from
 * `./model`, which `test/style/studio-mirrors-engine-enums.test.mjs` pins to
 * `src/core/sales/itemEnums.ts`. A control offering a value the engine refuses is a dead end and a
 * missing one is a capability no screen can reach, so the assertions below are over the whole set
 * rather than over one member somebody remembered.
 *
 * ROWS ARE ADDRESSED BY THE NAME A PERSON READS, via `rowNames`/`itemRow`. A D00 row prints the SKU
 * inside the same element as the name, so the `.item-name` text content of an item with an article
 * number is `A-100Beratung` and a bare `getByText('Beratung')` matches nothing at all. That is a
 * trap, not a preference: it silently turns a row assertion into a failed query.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { ITEM_KINDS, ITEM_UNITS } from './model';
import Items from './index';

/** A canned handler exactly as the transport calls it: the request input in, a RestResponse out. */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422, extra: Record<string, unknown> = {}): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

/** The revenue account the editor offers, off the recorded chart rather than a hand-typed row. */
const REVENUE = listAccountsFixture.accounts.find((a) => a.number === '3000');
if (REVENUE === undefined) throw new Error('the recorded chart has no account 3000');

// --- the workspace these tests describe -----------------------------------------------------------

/**
 * The category tree, handed over in a DELIBERATELY WRONG order. `categoryTree` sorts by (sort, name)
 * and the sidebar renders what it returns, so an input already in display order would prove nothing.
 */
const CATEGORIES = [
  { id: 'c_mineral', name: 'Mineralwasser', parentId: 'c_getraenke', sort: 1 },
  { id: 'c_getraenke', name: 'Getränke', parentId: null, sort: 2 },
  { id: 'c_dienst', name: 'Dienstleistungen', parentId: null, sort: 1 },
];

const PARENT = {
  id: 'i1',
  name: 'Beratung',
  sku: 'A-100',
  kind: 'service',
  unit: 'hour',
  categoryId: 'c_dienst',
  defaultUnitPriceMinor: 15000,
  costPriceMinor: 9000,
  currency: 'CHF',
  defaultTaxCode: null,
  revenueAccountId: REVENUE.id,
  archived: false,
};

const VARIANT_JUNIOR = {
  id: 'i1a',
  name: 'Beratung Junior',
  variantOfId: 'i1',
  kind: 'service',
  unit: 'hour',
  categoryId: 'c_dienst',
  defaultUnitPriceMinor: 12000,
  currency: 'CHF',
  archived: false,
};

const VARIANT_SENIOR = {
  id: 'i1b',
  name: 'Beratung Senior',
  variantOfId: 'i1',
  kind: 'service',
  categoryId: 'c_dienst',
  defaultUnitPriceMinor: 18000,
  currency: 'CHF',
  archived: false,
};

const PRODUCT = {
  id: 'i2',
  name: 'Wasserflasche',
  sku: 'A-200',
  kind: 'product',
  unit: 'piece',
  categoryId: 'c_getraenke',
  defaultUnitPriceMinor: 450,
  currency: 'CHF',
  trackStock: true,
  reorderPointQty: 24000,
  archived: false,
};

/** An A09-era row: no kind, no category, and a free-text unit the D00 enum does not admit. */
const LEGACY = {
  id: 'i4',
  name: 'Altbestand',
  unit: 'Stk',
  defaultUnitPriceMinor: 500,
  currency: 'CHF',
  archived: false,
};

const ARCHIVED = {
  id: 'i3',
  name: 'Altprodukt',
  defaultUnitPriceMinor: 5000,
  currency: 'CHF',
  archived: true,
};

const ACTIVE = [PARENT, VARIANT_JUNIOR, VARIANT_SENIOR, PRODUCT, LEGACY];

const HAPPY: Canned = {
  list_items: (input) => ok({ items: input.includeArchived === true ? [...ACTIVE, ARCHIVED] : ACTIVE }),
  list_accounts: ok({ accounts: listAccountsFixture.accounts }),
  vat_codes: ok({ taxCodes: [{ code: 'V81', label: '8.1% Normalsatz' }] }),
  get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
  item_categories_list: ok({ categories: CATEGORIES }),
};

function renderItems(canned: Canned = HAPPY, workspaceId: string | null = 'ws_test') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Items />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

// --- reading the rendered list --------------------------------------------------------------------

/** The name a person reads on a row, with the SKU that shares its element stripped back off. */
function nameOf(row: HTMLElement): string {
  const nameEl = row.querySelector('.item-name');
  if (nameEl === null) return '';
  const sku = nameEl.querySelector('.item-sku')?.textContent ?? '';
  return (nameEl.textContent ?? '').slice(sku.length).trim();
}

/** Every visible row name, in DOM order, so ordering is asserted as a list and not row by row. */
function rowNames(container: HTMLElement): string[] {
  // The catalog is the shared DataTable now (D118 B2): a row is a `<tr class="data-table-row">` and
  // the name still lives in an `.item-name` element inside it (see `nameOf`).
  return Array.from(container.querySelectorAll('tr.data-table-row')).map((row) => nameOf(row as HTMLElement));
}

function itemRow(container: HTMLElement, name: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll('tr.data-table-row')) as HTMLElement[];
  const hit = rows.find((row) => nameOf(row) === name);
  if (hit === undefined) {
    throw new Error(`no item row named "${name}". On screen: ${rowNames(container).join(', ') || '(none)'}`);
  }
  return hit;
}

/** The sidebar category rows, in DOM order, "Alle Artikel" included (the add control is a button). */
function sidebarLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.items-cat')).map((b) => b.textContent ?? '');
}

/** Wait for the catalog to settle on a row that is present in every fixture below. */
async function catalogReady(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(rowNames(container)).toContain('Beratung'));
}

/** Open the per-row overflow menu and choose one action by its label. */
async function rowAction(row: HTMLElement, name: string, action: string): Promise<void> {
  await userEvent.click(within(row).getByRole('button', { name: `Weitere Aktionen für Artikel ${name}` }));
  await userEvent.click(within(row).getByRole('menuitem', { name: action }));
}

/**
 * Confirm the destructive act the surface just asked about.
 *
 * The hard delete used to fire straight off the menu. Every block below that deletes anything goes
 * through here, so the confirm step is asserted by every one of them rather than by one test that
 * could be deleted on its own.
 */
async function confirm(label: string): Promise<void> {
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('button', { name: label }));
}

/**
 * Fill the in-app category-name dialog and confirm it (the themed replacement for `window.prompt`).
 *
 * The dialog carries the modeless dialog role (distinct from the delete confirm's alertdialog role),
 * with one text field and a Speichern/Abbrechen pair. `null` cancels instead of confirming; an empty
 * string submits blank so the inline validation can be asserted.
 */
async function fillCategoryDialog(name: string | null): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  if (name === null) {
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    return;
  }
  const input = within(dialog).getByRole('textbox');
  await userEvent.clear(input);
  if (name !== '') await userEvent.type(input, name);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
}

/** Open a sidebar category's action menu and choose one action. */
async function categoryAction(container: HTMLElement, name: string, action: string): Promise<void> {
  const entry = Array.from(container.querySelectorAll('.items-cat-entry')).find(
    (e) => e.querySelector('.items-cat')?.textContent === name,
  ) as HTMLElement | undefined;
  if (entry === undefined) throw new Error(`no sidebar category named "${name}"`);
  await userEvent.click(within(entry).getByRole('button', { name: `Aktionen für Kategorie ${name}` }));
  await userEvent.click(within(entry).getByRole('menuitem', { name: action }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- the category tree (US-D00.3) -----------------------------------------------------------------

describe('D00 categories, the sidebar tree', () => {
  it('renders the tree sorted by (sort, name), children under their own root', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    // Dienstleistungen sorts before Getränke on `sort`, and Mineralwasser follows ITS root, not the
    // other one. The input order is deliberately none of this.
    expect(sidebarLabels(container)).toEqual([
      'Alle Artikel',
      'Dienstleistungen',
      'Getränke',
      'Mineralwasser',
    ]);
    // K-22: the current category is announced, not only tinted. "Alle Artikel" is current on load.
    expect(screen.getByRole('button', { name: 'Alle Artikel' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Getränke' })).not.toHaveAttribute('aria-current');
    expect(
      (screen.getByRole('button', { name: 'Mineralwasser' }).className.includes('items-cat--child')),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Getränke' }).className).not.toContain('items-cat--child');
  });

  it('names the sidebar for assistive tech rather than leaving it an anonymous column', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    expect(screen.getByRole('navigation', { name: 'Kategorien' })).toBeInTheDocument();
  });

  it('filters the rows to one root category, and Alle Artikel puts them all back', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Getränke' }));
    expect(rowNames(container)).toEqual(['Wasserflasche']);

    await userEvent.click(screen.getByRole('button', { name: 'Alle Artikel' }));
    expect(rowNames(container)).toContain('Beratung');
    expect(rowNames(container)).toContain('Wasserflasche');
  });

  it('filters by a CHILD category on its own, never rolling its root up into it', async () => {
    // Nothing is filed under Mineralwasser, so a child filter that leaked its parent's rows would
    // show the bottled water here. The empty result is the assertion.
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Mineralwasser' }));
    expect(rowNames(container)).toEqual([]);
    expect(screen.getByText('Kein Artikel passt zur Suche.')).toBeInTheDocument();
  });

  it('keeps an uncategorised A09-era row out of every category filter but in Alle Artikel', async () => {
    const { container } = renderItems();
    await catalogReady(container);
    expect(rowNames(container)).toContain('Altbestand');

    await userEvent.click(screen.getByRole('button', { name: 'Dienstleistungen' }));
    expect(rowNames(container)).not.toContain('Altbestand');
  });

  it('creates a category from the entered name (trimmed) and re-reads the tree', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ category: { id: 'c_new' } }));
    let listCalls = 0;
    const { container } = renderItems({
      ...HAPPY,
      item_categories_upsert: upsertSpy,
      item_categories_list: () => {
        listCalls += 1;
        return ok({ categories: listCalls === 1 ? CATEGORIES : [...CATEGORIES, { id: 'c_new', name: 'Snacks', parentId: null, sort: 3 }] });
      },
    });
    await catalogReady(container);

    // The click opens the in-app dialog (no `window.prompt`); the write happens on confirm.
    await userEvent.click(screen.getByRole('button', { name: 'Neue Kategorie' }));
    await fillCategoryDialog('  Snacks  ');

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    const sent = upsertSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', name: 'Snacks' });
    expect(typeof sent.idempotencyKey).toBe('string');
    // The new root appears without a reload, which is what the re-read buys.
    expect(await screen.findByRole('button', { name: 'Snacks' })).toBeInTheDocument();
  });

  it('uses an in-app dialog, never window.prompt, and asks the engine for nothing when it is cancelled or left blank', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ category: { id: 'c_new' } }));
    // The whole point of f11: the browser prompt is gone, so a webview that suppresses it cannot make
    // naming a category silently inert. A spy proves it is never reached.
    const promptSpy = vi.spyOn(window, 'prompt');
    const { container } = renderItems({ ...HAPPY, item_categories_upsert: upsertSpy });
    await catalogReady(container);

    // Cancel: the dialog opens, the engine is asked nothing.
    await userEvent.click(screen.getByRole('button', { name: 'Neue Kategorie' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await fillCategoryDialog(null);
    expect(upsertSpy).not.toHaveBeenCalled();

    // Blank: Speichern refuses inline (validation), still no write.
    await userEvent.click(screen.getByRole('button', { name: 'Neue Kategorie' }));
    await fillCategoryDialog('');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Bitte gib einen Namen ein.');
    expect(upsertSpy).not.toHaveBeenCalled();

    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('reports a refused category create instead of leaving the confirm looking successful', async () => {
    const { container } = renderItems({ ...HAPPY, item_categories_upsert: reject('invalid_input') });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neue Kategorie' }));
    await fillCategoryDialog('Snacks');

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('Eine Eingabe war ungültig. Bitte prüfe die Felder und versuche es erneut.'),
    ).toBeInTheDocument();
    // The catalog is still usable: a failed category create is not a failed surface.
    expect(rowNames(container)).toContain('Beratung');
  });

  it('creates a CHILD under a root, which is the second level the engine has always admitted', async () => {
    // The whole of finding 8. `item_categories_upsert` was only ever called as `{ workspaceId, name }`,
    // so the Studio could create roots and nothing else: no child, no rename, no re-file. A verb that is
    // built, registered and tested but that no surface can reach is missing functionality.
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ category: { id: 'c_new' } }));
    const { container } = renderItems({ ...HAPPY, item_categories_upsert: upsertSpy });
    await catalogReady(container);

    await categoryAction(container, 'Getränke', 'Unterkategorie anlegen');
    await fillCategoryDialog('Kaffee');

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ name: 'Kaffee', parentId: 'c_getraenke' });
  });

  it('offers no third level: a CHILD category cannot take a child of its own', async () => {
    // Two levels is a fixed structural invariant (spec §6b), and the engine refuses a third with
    // `category_nesting_too_deep`. Offering the action and then being refused would be a dead end.
    const { container } = renderItems();
    await catalogReady(container);

    const entry = Array.from(container.querySelectorAll('.items-cat-entry')).find(
      (e) => e.querySelector('.items-cat')?.textContent === 'Mineralwasser',
    ) as HTMLElement;
    await userEvent.click(within(entry).getByRole('button', { name: 'Aktionen für Kategorie Mineralwasser' }));
    expect(within(entry).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Umbenennen',
      'Kategorie löschen',
    ]);
  });

  it('renames a category through the same upsert, carrying its id and nothing else', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ category: { id: 'c_getraenke' } }));
    const { container } = renderItems({ ...HAPPY, item_categories_upsert: upsertSpy });
    await catalogReady(container);

    await categoryAction(container, 'Getränke', 'Umbenennen');
    // The dialog is prefilled with the current name; `fillCategoryDialog` clears it first.
    await fillCategoryDialog('Getränke und Sirup');

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    const sent = upsertSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ categoryId: 'c_getraenke', name: 'Getränke und Sirup' });
    // No parentId in the patch: a rename must not silently re-file the category at the root.
    expect(sent).not.toHaveProperty('parentId');
  });

  it('asks nothing of the engine when a rename is cancelled or left unchanged', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok({ category: { id: 'c_getraenke' } }));
    const { container } = renderItems({ ...HAPPY, item_categories_upsert: upsertSpy });
    await catalogReady(container);

    await categoryAction(container, 'Getränke', 'Umbenennen');
    await fillCategoryDialog(null);
    expect(upsertSpy).not.toHaveBeenCalled();

    // The same name back is not an edit, and a write that changes nothing is still an audit-log row.
    await categoryAction(container, 'Getränke', 'Umbenennen');
    await fillCategoryDialog('Getränke');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('deletes a category behind a confirm, and resets a filter that pointed at it', async () => {
    // `item_categories_delete` had ZERO callers anywhere in the Studio. It has one now, and the filter
    // travels with it: a filter on a category that no longer exists shows an empty catalog with nothing
    // on screen that reads as an explanation.
    const deleteSpy = vi.fn<CannedHandler>(() => ok({ deleted: true }));
    let listCalls = 0;
    const { container } = renderItems({
      ...HAPPY,
      item_categories_delete: deleteSpy,
      item_categories_list: () => {
        listCalls += 1;
        return ok({ categories: listCalls === 1 ? CATEGORIES : CATEGORIES.filter((c) => c.id !== 'c_dienst') });
      },
    });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Dienstleistungen' }));
    await categoryAction(container, 'Dienstleistungen', 'Kategorie löschen');
    expect(deleteSpy, 'the menu press alone must not delete anything').not.toHaveBeenCalled();

    await confirm('Kategorie löschen');
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledOnce());
    const sent = deleteSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', categoryId: 'c_dienst' });
    expect(typeof sent.idempotencyKey).toBe('string');
    // Back to "Alle Artikel", so every row is visible again rather than none.
    await waitFor(() => expect(rowNames(container)).toContain('Wasserflasche'));
  });

  it('explains category_in_use rather than showing the generic fallback', async () => {
    const { container } = renderItems({ ...HAPPY, item_categories_delete: reject('category_in_use') });
    await catalogReady(container);

    await categoryAction(container, 'Getränke', 'Kategorie löschen');
    await confirm('Kategorie löschen');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Diese Kategorie wird noch verwendet/)).toBeInTheDocument();
    // The tree is untouched: a refused delete is not a broken sidebar.
    expect(sidebarLabels(container)).toContain('Getränke');
  });

  it('degrades to no tree at all when the category read fails, and still lists the items', async () => {
    // Categories are additive (spec §6): a workspace with none, or an engine that has not shipped the
    // read, must not take the item list down with it.
    const { container } = renderItems({ ...HAPPY, item_categories_list: reject('unknown_action', 404) });
    await catalogReady(container);

    expect(sidebarLabels(container)).toEqual(['Alle Artikel']);
    expect(screen.getByRole('button', { name: 'Neue Kategorie' })).toBeInTheDocument();
    expect(rowNames(container)).toContain('Wasserflasche');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// --- variants (US-D00.2) --------------------------------------------------------------------------

describe('D00 variants, indented under their parent', () => {
  it('places each variant directly under its own parent, sorted, and nowhere else', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    // Parents alphabetical (Altbestand, Beratung, Wasserflasche), each followed by its variants.
    expect(rowNames(container)).toEqual([
      'Altbestand',
      'Beratung',
      'Beratung Junior',
      'Beratung Senior',
      'Wasserflasche',
    ]);
    // The variant indent is on the name cell now (DataTable rows carry no per-row modifier class).
    expect(itemRow(container, 'Beratung Junior').querySelector('.item-name')?.className).toContain(
      'item-name--variant',
    );
    expect(itemRow(container, 'Beratung').querySelector('.item-name')?.className).not.toContain(
      'item-name--variant',
    );
  });

  it('drops a variant when its parent is filtered out, because the filter is on the parent set', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.type(screen.getByPlaceholderText('Artikel suchen'), 'Wasser');
    await waitFor(() => expect(rowNames(container)).toEqual(['Wasserflasche']));
  });

  it('keeps a matching parent WITH its variants, even though the variants do not match the query', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.type(screen.getByPlaceholderText('Artikel suchen'), 'Beratung');
    await waitFor(() =>
      expect(rowNames(container)).toEqual(['Beratung', 'Beratung Junior', 'Beratung Senior']),
    );
  });

  it('matches the search against the unit LABEL the row prints, and against the stored code', async () => {
    // CHANGED 2026-07-30. This block used to record the mismatch as a finding: `matchesSearch` read the
    // stored value, which D00 narrowed to the enum CODE `hour`, while the row prints `Stunde`. Searching
    // for what was visibly on screen returned nothing, which is the worst answer a search box can give.
    const { container } = renderItems();
    await catalogReady(container);
    const box = screen.getByPlaceholderText('Artikel suchen');

    await userEvent.type(box, 'Stunde');
    await waitFor(() =>
      expect(rowNames(container)).toEqual(['Beratung', 'Beratung Junior', 'Beratung Senior']),
    );

    // The code still matches, because a pre-D00 row stores free text and an agent may know the enum.
    await userEvent.clear(box);
    await userEvent.type(box, 'hour');
    await waitFor(() =>
      expect(rowNames(container)).toEqual(['Beratung', 'Beratung Junior', 'Beratung Senior']),
    );
  });

  it('matches the search against the ARTICLE NUMBER, which the engine already filters on', async () => {
    // `list_items` matches `name LIKE ? OR item_sku LIKE ?`, so without this the engine narrowed its
    // answer to the right row and the client then filtered that same row back out again.
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.type(screen.getByPlaceholderText('Artikel suchen'), 'A-100');
    await waitFor(() => expect(rowNames(container)).toContain('Beratung'));
    expect(rowNames(container)).not.toContain('Wasserflasche');
  });

  it('opens a variant drawer titled for its parent, seeded with the parent defaults', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await rowAction(itemRow(container, 'Beratung'), 'Beratung', 'Variante anlegen');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Neue Variante von Beratung' })).toBeInTheDocument();
    // Inherited: the engine snapshots the parent defaults at creation, and the operator sees them.
    expect(within(dialog).getByLabelText('Verkaufspreis')).toHaveValue('150.00');
    expect(within(dialog).getByLabelText('Einstandspreis')).toHaveValue('90.00');
    expect(within(dialog).getByRole('combobox', { name: 'Art' })).toHaveTextContent('Dienstleistung');
    expect(within(dialog).getByRole('combobox', { name: 'Einheit' })).toHaveTextContent('Stunde');
    expect(within(dialog).getByRole('combobox', { name: 'Kategorie' })).toHaveTextContent('Dienstleistungen');
    // NOT inherited: an article number is unique per workspace, so a copied one is `sku_taken`.
    expect(within(dialog).getByLabelText('Artikelnummer')).toHaveValue('');
    // The name is the one thing a variant must state for itself.
    expect(within(dialog).getByLabelText('Bezeichnung')).toHaveValue('');
  });

  it('creates a variant with variantOfId, and never with the parent article number', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'i1c' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await rowAction(itemRow(container, 'Beratung'), 'Beratung', 'Variante anlegen');
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Beratung Partner');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    const sent = createSpy.mock.calls[0][0];
    expect(sent).toMatchObject({
      workspaceId: 'ws_test',
      name: 'Beratung Partner',
      variantOfId: 'i1',
      defaultUnitPriceMinor: 15000,
      kind: 'service',
      unit: 'hour',
      categoryId: 'c_dienst',
    });
    expect(sent.sku).toBeUndefined();
  });

  it('offers no variant action on an archived row, whose only ways out are restore and delete', async () => {
    const { container } = renderItems();
    await catalogReady(container);
    await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
    await waitFor(() => expect(rowNames(container)).toContain('Altprodukt'));

    const row = itemRow(container, 'Altprodukt');
    await userEvent.click(
      within(row).getByRole('button', { name: 'Weitere Aktionen für Artikel Altprodukt' }),
    );
    const menu = within(row).getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Wiederherstellen',
      'Löschen',
    ]);
  });

  it('restores an archived row through unarchive_item', async () => {
    const unarchiveSpy = vi.fn<CannedHandler>(() => ok());
    const { container } = renderItems({ ...HAPPY, unarchive_item: unarchiveSpy });
    await catalogReady(container);
    await userEvent.click(screen.getByLabelText('Archivierte anzeigen'));
    await waitFor(() => expect(rowNames(container)).toContain('Altprodukt'));

    await rowAction(itemRow(container, 'Altprodukt'), 'Altprodukt', 'Wiederherstellen');

    await waitFor(() => expect(unarchiveSpy).toHaveBeenCalledOnce());
    expect(unarchiveSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', itemId: 'i3' });
  });
});

// --- the hard delete and its reference census (US-D00.6) ------------------------------------------

describe('D00 delete, fenced by the engine reference census', () => {
  it('deletes an orphan item and re-reads the list so the row goes away', async () => {
    // CHANGED 2026-07-30: the menu item no longer deletes on its own. It opens a confirm, which is what
    // every other destructive action in the Studio does and what this one, the only irreversible act on
    // the surface, uniquely did not.
    const deleteSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'i4', deleted: true }));
    let listCalls = 0;
    const { container } = renderItems({
      ...HAPPY,
      delete_item: deleteSpy,
      list_items: () => {
        listCalls += 1;
        return ok({ items: listCalls === 1 ? ACTIVE : ACTIVE.filter((i) => i.id !== 'i4') });
      },
    });
    await catalogReady(container);

    await rowAction(itemRow(container, 'Altbestand'), 'Altbestand', 'Löschen');
    expect(deleteSpy, 'the menu press alone must not delete anything').not.toHaveBeenCalled();
    await confirm('Endgültig löschen');

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledOnce());
    const sent = deleteSpy.mock.calls[0][0];
    expect(sent).toMatchObject({ workspaceId: 'ws_test', itemId: 'i4' });
    // The delete is a write, so it carries a key (§H-IDEMPOTENT): a replay must not be a second delete.
    expect(typeof sent.idempotencyKey).toBe('string');
    await waitFor(() => expect(rowNames(container)).not.toContain('Altbestand'));
  });

  it('names the item in the confirm and deletes nothing when it is cancelled', async () => {
    const deleteSpy = vi.fn<CannedHandler>(() => ok({ deleted: true }));
    const { container } = renderItems({ ...HAPPY, delete_item: deleteSpy });
    await catalogReady(container);

    await rowAction(itemRow(container, 'Altbestand'), 'Altbestand', 'Löschen');
    const dialog = await screen.findByRole('alertdialog');
    // The name is IN the question: the operator confirms a specific row, not "the delete".
    expect(within(dialog).getByText(/Altbestand/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Archivieren behält ihn in der Historie/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(rowNames(container)).toContain('Altbestand');
  });

  it('marks Löschen as the danger item, on an active row and on an archived one alike', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    const row = itemRow(container, 'Beratung');
    await userEvent.click(within(row).getByRole('button', { name: 'Weitere Aktionen für Artikel Beratung' }));
    // `danger` is the class the shared menu renders for a destructive item; every other caller in the
    // Studio sets it and this one omitted it, so the one irreversible action was also the quietest.
    expect(within(row).getByRole('menuitem', { name: 'Löschen' })).toHaveClass('btn--danger');
    expect(within(row).getByRole('menuitem', { name: 'Archivieren' })).not.toHaveClass('btn--danger');
  });

  it('reports item_referenced and LEAVES THE ROW STANDING, which is the whole point of the census', async () => {
    // The engine refuses to delete anything a document line, a price-list row, a variant or a stock
    // movement still points at, so posted history stays resolvable. A surface that removed the row
    // optimistically would show a deletion that did not happen.
    //
    // CHANGED 2026-07-30: this used to allow an i18n miss on `errors.item_referenced` and assert only
    // that SOME alert appeared. The code is mapped now, the `refs` the engine sends are named, and the
    // archive alternative the engine's own docblock promises is on screen.
    const { container } = renderItems({
      ...HAPPY,
      delete_item: reject('item_referenced', 422, { refs: ['document_line', 'price_list_item'] }),
    });
    await catalogReady(container);

    await rowAction(itemRow(container, 'Beratung'), 'Beratung', 'Löschen');
    await confirm('Endgültig löschen');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Dieser Artikel wird noch verwendet/)).toBeInTheDocument();
    // The refs are the reason the payload carries them: the operator learns WHAT still points at it.
    expect(within(alert).getByText(/Noch verwendet: Belegzeilen, Preislisten/)).toBeInTheDocument();
    expect(rowNames(container)).toContain('Beratung');
  });

  it('does NOT offer to report a refusal by a working fence as a bug (D48)', async () => {
    // The sharp edge behind finding 1. `ErrorBanner` treats an UNMAPPED code as `reportable`, so while
    // `errors.item_referenced` had no message the census refusing a delete offered the operator a
    // bug-report button for correct, deliberate engine behaviour.
    const { container } = renderItems({
      ...HAPPY,
      delete_item: reject('item_referenced', 422, { refs: ['variant'] }),
    });
    await catalogReady(container);

    await rowAction(itemRow(container, 'Beratung'), 'Beratung', 'Löschen');
    await confirm('Endgültig löschen');

    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button', { name: 'Diesen Fehler melden' })).not.toBeInTheDocument();
  });

  it('offers ARCHIVE as the way forward on a refused delete, and it works from there', async () => {
    // `deleteItem`'s docblock says the caller offers archive instead. It did not, so the operator was
    // told no and left to find the alternative in a menu they had just been refused from.
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    const { container } = renderItems({
      ...HAPPY,
      delete_item: reject('item_referenced', 422, { refs: ['document_line'] }),
      archive_item: archiveSpy,
    });
    await catalogReady(container);

    await rowAction(itemRow(container, 'Beratung'), 'Beratung', 'Löschen');
    await confirm('Endgültig löschen');

    await userEvent.click(await screen.findByRole('button', { name: 'Stattdessen archivieren' }));
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledOnce());
    expect(archiveSpy.mock.calls[0][0]).toMatchObject({ itemId: 'i1' });
  });

  it('archives from the same menu, so the refused delete has a real alternative', async () => {
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    const { container } = renderItems({ ...HAPPY, archive_item: archiveSpy });
    await catalogReady(container);

    const row = itemRow(container, 'Beratung');
    await userEvent.click(
      within(row).getByRole('button', { name: 'Weitere Aktionen für Artikel Beratung' }),
    );
    // Destructive last (D15/C2): the order the surface passes is the order the menu renders.
    expect(within(row).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Variante anlegen',
      'Archivieren',
      'Löschen',
    ]);
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Archivieren' }));

    await waitFor(() => expect(archiveSpy).toHaveBeenCalledOnce());
    expect(archiveSpy.mock.calls[0][0]).toMatchObject({ itemId: 'i1' });
  });
});

// --- the article number ---------------------------------------------------------------------------

describe('D00 sku, the article number', () => {
  it('prints the article number on the row it belongs to, and nothing on a row without one', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    expect(within(itemRow(container, 'Beratung')).getByText('A-100')).toBeInTheDocument();
    expect(within(itemRow(container, 'Wasserflasche')).getByText('A-200')).toBeInTheDocument();
    expect(itemRow(container, 'Altbestand').querySelector('.item-sku')).toBeNull();
  });

  it('sends the typed article number on create, and omits it entirely when left blank', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Fotografie');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '150');
    await userEvent.type(within(dialog).getByLabelText('Artikelnummer'), '  A-300  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ sku: 'A-300' });
    // The spy fires when the request goes IN FLIGHT; the editor closes only when its answer has
    // been processed. Reopening before that lands on the STALE dialog, whose fields still hold the
    // first item and whose Speichern is still saving-disabled. Wait for the close it depends on.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Ohne Nummer');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    // Absent, not the empty string: `''` would be a taken article number on the next create.
    expect(createSpy.mock.calls[1][0].sku).toBeUndefined();
  });

  it('seeds the editor from the stored article number and clears it to null in the patch', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    const { container } = renderItems({ ...HAPPY, update_item: updateSpy });
    await catalogReady(container);

    await userEvent.click(itemRow(container, 'Beratung'));
    const dialog = await screen.findByRole('dialog');
    const sku = within(dialog).getByLabelText('Artikelnummer');
    expect(sku).toHaveValue('A-100');

    await userEvent.clear(sku);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    // An explicit null CLEARS the column; undefined would leave the old number in place.
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ itemId: 'i1', patch: { sku: null } });
  });

  it('surfaces sku_taken on the article-number field itself, not as a banner at the top', async () => {
    const { container } = renderItems({ ...HAPPY, create_item: reject('sku_taken') });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Doppelt');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '10');
    await userEvent.type(within(dialog).getByLabelText('Artikelnummer'), 'A-100');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    const sku = within(dialog).getByLabelText('Artikelnummer');
    expect(await within(dialog).findByText('Diese Artikelnummer ist bereits vergeben.')).toBeInTheDocument();
    // Inline means BESIDE THE FIELD and wired to it, not a sentence floating at the top of the drawer.
    expect(sku).toHaveAttribute('aria-invalid', 'true');
    const describedBy = sku.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Diese Artikelnummer ist bereits vergeben.',
    );
  });
});

// --- the kind and unit enums (§H-ENUM) ------------------------------------------------------------

describe('D00 kind and unit, mirrored enums and nothing invented', () => {
  it('offers exactly the engine kinds, plus one honest "not stated" option', async () => {
    const { container } = renderItems();
    await catalogReady(container);
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Art' }));
    const options = within(screen.getByRole('listbox', { name: 'Art' })).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual(['', ...ITEM_KINDS]);
    expect(options.map((o) => o.querySelector('.select-option-label')?.textContent)).toEqual([
      'Nicht angegeben',
      'Produkt',
      'Dienstleistung',
    ]);
  });

  it('offers exactly the engine units, every one of them localised', async () => {
    const { container } = renderItems();
    await catalogReady(container);
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Einheit' }));
    const options = within(screen.getByRole('listbox', { name: 'Einheit' })).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual(['', ...ITEM_UNITS]);
    // No option fell back to a raw i18n key, which is what an unlocalised new enum member looks like.
    for (const option of options)
      expect(option.querySelector('.select-option-label')?.textContent).not.toMatch(/^item\.unit\./);
  });

  it('sends the enum VALUE the engine admits, never the German label a person read', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Pauschale');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '2000');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Art' }));
    await userEvent.click(screen.getByRole('option', { name: 'Dienstleistung' }));
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Einheit' }));
    await userEvent.click(screen.getByRole('option', { name: 'Pauschal' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ kind: 'service', unit: 'flat' });
  });

  it('renders an enum unit as its label and a legacy free-text unit verbatim', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    expect(within(itemRow(container, 'Beratung')).getByText('Stunde')).toBeInTheDocument();
    expect(within(itemRow(container, 'Wasserflasche')).getByText('Stück')).toBeInTheDocument();
    // An A09-era row keeps whatever it was typed as: the enum did not exist when it was written, and
    // a row is never rewritten by the screen that reads it.
    expect(within(itemRow(container, 'Altbestand')).getByText('Stk')).toBeInTheDocument();
  });

  it('shows the category a row is filed under, by name and not by id', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    expect(within(itemRow(container, 'Wasserflasche')).getByText('Getränke')).toBeInTheDocument();
    expect(within(itemRow(container, 'Wasserflasche')).queryByText('c_getraenke')).not.toBeInTheDocument();
  });
});

// --- the stock dials (US-D00.5), and the D15 inline reason -----------------------------------------

describe('D00 stock dials, and a disabled control that says why', () => {
  it('disables Lagerführung for a service and states the reason INLINE, with no hover (D15/C3)', async () => {
    const { container } = renderItems();
    await catalogReady(container);
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Art' }));
    await userEvent.click(screen.getByRole('option', { name: 'Dienstleistung' }));

    const toggle = within(dialog).getByLabelText('Lagerführung');
    expect(toggle).toBeDisabled();
    // The reason sits in the same field block as the control it explains, present on first paint.
    const field = toggle.closest('.item-field') as HTMLElement;
    expect(
      within(field).getByText('Für Dienstleistungen ist keine Lagerführung möglich.'),
    ).toBeInTheDocument();
    // Not a tooltip: nothing was hovered, and there is no tooltip to hover.
    expect(within(dialog).queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('drops a stock flag that was set before the kind became a service', async () => {
    // The engine answers `services_not_stockable`, so sending the stale flag would be a dead end the
    // operator can see is checked. The editor sends what the engine can accept.
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Wechselhaft');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '10');
    await userEvent.click(within(dialog).getByLabelText('Lagerführung'));
    expect(within(dialog).getByLabelText('Lagerführung')).toBeChecked();

    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Art' }));
    await userEvent.click(screen.getByRole('option', { name: 'Dienstleistung' }));
    expect(within(dialog).getByLabelText('Lagerführung')).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ kind: 'service', trackStock: false });
  });

  it('reveals the Meldebestand only once stock is tracked, and sends it in thousandths', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Meldebestand')).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Kiste');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '12');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Art' }));
    await userEvent.click(screen.getByRole('option', { name: 'Produkt' }));
    await userEvent.click(within(dialog).getByLabelText('Lagerführung'));
    await userEvent.type(await within(dialog).findByLabelText('Meldebestand'), '10.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // D01's `stock_movement.qty` convention: integer thousandths, so 10.5 pieces is 10500.
    expect(createSpy.mock.calls[0][0]).toMatchObject({ trackStock: true, reorderPointQty: 10500 });
  });

  it('sends no Meldebestand at all when the field was never touched', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Kiste');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '12');
    await userEvent.click(within(dialog).getByLabelText('Lagerführung'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // Null, not zero: an untouched threshold is "none set", and zero is a real low-stock threshold.
    expect(createSpy.mock.calls[0][0]).toMatchObject({ reorderPointQty: null });
  });

  it('seeds the editor from a tracked product, threshold included and trailing zeros trimmed', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.click(itemRow(container, 'Wasserflasche'));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText('Lagerführung')).toBeChecked();
    // 24000 thousandths is 24 pieces, not "24.000".
    expect(within(dialog).getByLabelText('Meldebestand')).toHaveValue('24');
  });

  it('surfaces stock_on_hand_nonzero beside the stock control that provoked it', async () => {
    const { container } = renderItems({ ...HAPPY, update_item: reject('stock_on_hand_nonzero') });
    await catalogReady(container);

    await userEvent.click(itemRow(container, 'Wasserflasche'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Lagerführung'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    const message = await within(dialog).findByText(
      'Der Lagerbestand muss null sein, bevor die Lagerführung deaktiviert wird.',
    );
    const field = within(dialog).getByLabelText('Lagerführung').closest('.item-field') as HTMLElement;
    expect(field).toContainElement(message);
    // A rejection the surface can place on a field never becomes a generic banner.
    expect(within(dialog).queryByText('Aktion fehlgeschlagen')).not.toBeInTheDocument();
  });
});

// --- the cost price -------------------------------------------------------------------------------

describe('D00 cost price, the Einstandspreis', () => {
  it('sends the Einstandspreis as integer Rappen, and null when the field is empty', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Handelsware');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '120');
    await userEvent.type(within(dialog).getByLabelText('Einstandspreis'), '80.25');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ defaultUnitPriceMinor: 12000, costPriceMinor: 8025 });
    // Same in-flight-is-not-answered race as the article-number test: wait for the first editor to
    // close before reopening, or the second dialog is the stale first one.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Ohne Einstand');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '120');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    expect(createSpy.mock.calls[1][0]).toMatchObject({ costPriceMinor: null });
  });

  it('blocks the save on an unparseable Einstandspreis and reports it ON THE EINSTANDSPREIS FIELD', async () => {
    // CHANGED 2026-07-30, twice over. The input was `80,25`, which is now a VALID Swiss comma decimal
    // and no longer refused at all, so the unparseable value is a genuinely unparseable one. And the
    // message used to be `setPriceError`, so a bad cost price blocked the save (correctly) and then
    // pointed at the Verkaufspreis control the operator had typed nothing wrong into: exactly what
    // D15/C3 governs.
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Krumm');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '120');
    await userEvent.type(within(dialog).getByLabelText('Einstandspreis'), '80.2.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    expect(createSpy).not.toHaveBeenCalled();
    const message = await within(dialog).findByText('Bitte gib einen gültigen Einstandspreis ein (z. B. 90.00).');
    expect(message).toBeInTheDocument();
    // The message is BOUND to the Einstandspreis control, not merely near it, and the Verkaufspreis is
    // left alone: an assertion over the text only would pass with both fields flagged.
    const cost = within(dialog).getByLabelText('Einstandspreis');
    expect(cost).toHaveAttribute('aria-invalid', 'true');
    expect(cost.getAttribute('aria-describedby')).toBe(message.id);
    expect(within(dialog).getByLabelText('Verkaufspreis')).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts a Swiss comma decimal in both money fields, exactly as the dot form', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ item: { id: 'new' } }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Kommazahl');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '150,50');
    await userEvent.type(within(dialog).getByLabelText('Einstandspreis'), '90,25');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // Integer Rappen, read off the digits rather than through a float (P2).
    expect(createSpy.mock.calls[0][0]).toMatchObject({ defaultUnitPriceMinor: 15050, costPriceMinor: 9025 });
  });

  it('seeds the editor from the stored Einstandspreis', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.click(itemRow(container, 'Beratung'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Einstandspreis')).toHaveValue('90.00');
  });
});

// --- the category picker in the editor ------------------------------------------------------------

describe('D00 the editor category picker', () => {
  it('offers every loaded category and files the new item under the chosen one', async () => {
    const createSpy = vi.fn<CannedHandler>(() => ok({ itemId: 'new' }));
    const { container } = renderItems({ ...HAPPY, create_item: createSpy });
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');
    const picker = within(dialog).getByRole('combobox', { name: 'Kategorie' });
    await userEvent.click(picker);
    const values = within(screen.getByRole('listbox', { name: 'Kategorie' }))
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-value'));
    expect(values).toEqual(['', ...CATEGORIES.map((c) => c.id)]);
    await userEvent.click(screen.getByRole('option', { name: 'Mineralwasser' }));

    await userEvent.type(within(dialog).getByLabelText('Bezeichnung'), 'Mineral');
    await userEvent.type(within(dialog).getByLabelText('Verkaufspreis'), '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({ categoryId: 'c_mineral' });
  });

  it('clears an item out of its category with an explicit null in the patch', async () => {
    const updateSpy = vi.fn<CannedHandler>(() => ok());
    const { container } = renderItems({ ...HAPPY, update_item: updateSpy });
    await catalogReady(container);

    await userEvent.click(itemRow(container, 'Beratung'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Kategorie' }));
    await userEvent.click(screen.getByRole('option', { name: 'Keine Kategorie' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ patch: { categoryId: null } });
  });
});

// --- the drawer is a real modal: it traps focus and closes on Escape (D46 UX pass) ----------------

describe('D00 the item drawer, a focus-trapping modal', () => {
  // The drawer is a modal dialog (aria-modal true), which PROMISES a keyboard user that Tab cannot
  // walk out to the catalog behind the scrim and that Escape closes it. The modal flag alone enforces
  // neither: before this pass the drawer hand-rolled no trap, no Escape and no focus restore, so Tab
  // escaped mid-edit. It uses the shared `useFocusTrap` now, the same one every other Studio modal does.
  it('lands focus inside the drawer when it opens', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    const opener = screen.getByRole('button', { name: 'Neuer Artikel' });
    await userEvent.click(opener);

    const dialog = await screen.findByRole('dialog');
    // The hook seeds focus to the first focusable inside the dialog, so focus is never stranded on the
    // body behind the scrim.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('closes on Escape and hands focus back to the control that opened it', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    const opener = screen.getByRole('button', { name: 'Neuer Artikel' });
    await userEvent.click(opener);
    await screen.findByRole('dialog');

    await userEvent.keyboard('{Escape}');

    // The drawer is gone, and focus is back on the opener rather than lost to the body (useFocusTrap
    // restores it on unmount), so a keyboard user is not dropped at the top of the page.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('keeps a Tab at the last control inside the dialog rather than escaping to the catalog', async () => {
    const { container } = renderItems();
    await catalogReady(container);

    await userEvent.click(screen.getByRole('button', { name: 'Neuer Artikel' }));
    const dialog = await screen.findByRole('dialog');

    // Focus the last focusable (Speichern) and Tab: the trap wraps to the first focusable inside the
    // dialog, never onto a control in the list behind the scrim.
    within(dialog).getByRole('button', { name: 'Speichern' }).focus();
    await userEvent.tab();

    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
