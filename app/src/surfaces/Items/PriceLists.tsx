/**
 * The Preislisten tab (D00 US-D00.4): the operator twin of the price-list verbs.
 *
 * Create a price list scoped to a segment or a contact, add append-only prices per item from a
 * validFrom date, remove a price or a whole list, and preview the resolved price for an item and
 * contact (the agent-primary `price_resolve`, precedence contact then segment then base). Prices
 * render through the P11 formatMoney helper; the entered amount is parsed to integer Rappen once at
 * the edge (P2), and a Swiss comma decimal is accepted there.
 *
 * ## FIVE STATES, AND WHY THE EMPTY ONE USED TO LIE TWICE (2026-07-30)
 *
 * `lists.length === 0` rendered `EmptyState` unconditionally, so "Noch keine Preislisten" was on
 * screen WHILE `price_lists_list` was in flight, and again NEXT TO the error banner when that read was
 * refused. Both readings are false and the second is the dangerous one: "you have no price lists" and
 * "we could not read your price lists" are opposite facts, and the operator acts on the first.
 *
 * A denied read had no state of its own either. `Items.tsx` inspects `list_items` for
 * `permission_denied`, so the padlock panel was unreachable from this tab even though
 * `price_lists_list` gates on `read_master_data` exactly like every other read here.
 *
 * ## NO DEAD-END PRIMARY (D15/C3)
 *
 * `createList`, `addPrice` and `preview` each `return`ed silently on incomplete input: an enabled
 * button that does nothing and says nothing, which is the one outcome the canon has no name for
 * because there is nothing to name. Every one of them is now honestly DISABLED with the missing
 * precondition beside it, the pattern `/periods` established and `ItemEditor` already followed.
 * `addPrice` was the worst of the three, because `12,50` is how a Swiss operator types twelve francs
 * fifty and the button simply went dead on it.
 */
import { useCallback, useEffect, useMemo, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, useTStrict, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ConfirmDialog } from '../Accounts/ConfirmDialog';
import type { Err } from '../../lib/client';
import {
  idemKey,
  isIsoDay,
  parseAmountToMinor,
  type ContactOption,
  type Item,
  type PriceList,
  type PriceRow,
} from './model';

export interface PriceListsProps {
  workspaceId: string;
  items: Item[];
  baseCurrency: string;
  /**
   * A24 `manage_master_data` (F5): every price-list write is gated on it, so the create panel, the
   * set-price form and both delete overflows are ABSENT without it. The lists, the price rows and
   * the resolver stay: they are reads.
   */
  canManage: boolean;
}

/** A pending destructive act on this tab: a whole list, or one item's price inside a list. */
type Pending = { kind: 'list'; list: PriceList } | { kind: 'price'; row: PriceRow; name: string } | null;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function PriceLists({ workspaceId, items, baseCurrency, canManage }: PriceListsProps) {
  const t = useT();
  const tStrict = useTStrict();
  const client = useClient();
  const noteId = useId();

  /**
   * The lists, or `null` while `price_lists_list` has not answered SUCCESSFULLY.
   *
   * Not `[]`, and the distinction is the whole of finding 4: an empty array cannot tell "this workspace
   * has no price lists" from "we could not read them", and the tab used to render the empty state for
   * both, once during the load and once beside the error banner. A type that cannot represent the
   * confusion is cheaper than remembering to check a second flag.
   */
  const [lists, setLists] = useState<PriceList[] | null>(null);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  /** Whether the contact register could be read at all. False degrades the picker to a typed id (P9). */
  const [contactsReadable, setContactsReadable] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  // Create-list form.
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'segment' | 'contact'>('segment');
  const [scopeValue, setScopeValue] = useState('');

  // Set-price form.
  const [priceItemId, setPriceItemId] = useState('');
  const [priceAmount, setPriceAmount] = useState('');
  const [validFrom, setValidFrom] = useState('');

  // Resolve preview.
  const [resolveItemId, setResolveItemId] = useState('');
  const [resolveContactId, setResolveContactId] = useState('');
  const [resolveResult, setResolveResult] = useState<{ priceMinor: number; currency: string; source: string } | null>(
    null,
  );

  const loadLists = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDenied(false);
    const [listsResp, contactsResp] = await Promise.all([
      client.call('price_lists_list', { workspaceId }),
      client.call('list_contacts', { workspaceId }),
    ]);

    if (isErr(listsResp.body)) {
      // The same test `Items.tsx` applies to `list_items`: a missing right is its own state, not a
      // banner that reads like a malfunction.
      if (listsResp.body.error === 'permission_denied' || listsResp.status === 403) setDenied(true);
      else setError(listsResp.body);
      setLoading(false);
      return;
    }
    setLists(asArray<PriceList>(listsResp.body.priceLists));
    // The contact register is a SEPARATE right (`read_master_data` over contacts) and a separate
    // capability's surface. Failing to read it degrades the picker; it never takes this tab down.
    setContactsReadable(!isErr(contactsResp.body));
    setContacts(isErr(contactsResp.body) ? [] : asArray<ContactOption>(contactsResp.body.contacts));
    setLoading(false);
  }, [client, workspaceId]);

  const loadPrices = useCallback(
    async (listId: string) => {
      const resp = await client.call('price_lists_get', { workspaceId, priceListId: listId });
      if (isErr(resp.body)) setError(resp.body);
      else setPrices(asArray<PriceRow>(resp.body.prices));
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (selected !== null) void loadPrices(selected);
    else setPrices([]);
  }, [selected, loadPrices]);

  /** The contacts that already hold a price list: one scope holds at most one (F4, `scope_taken`). */
  const listedContactIds = useMemo(
    () =>
      new Set(
        (lists ?? []).map((l) => l.contactId).filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    [lists],
  );

  async function createList() {
    setError(null);
    const resp = await client.call('price_lists_upsert', {
      workspaceId,
      name: name.trim(),
      contactId: scope === 'contact' ? scopeValue.trim() : undefined,
      segment: scope === 'segment' ? scopeValue.trim() : undefined,
      idempotencyKey: idemKey('pl'),
    });
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    setName('');
    setScopeValue('');
    void loadLists();
  }

  async function addPrice() {
    if (selected === null) return;
    setError(null);
    const priceMinor = parseAmountToMinor(priceAmount);
    if (priceMinor === null) return;
    const resp = await client.call('price_lists_set_price', {
      workspaceId,
      priceListId: selected,
      itemId: priceItemId,
      priceMinor,
      validFrom: validFrom.trim(),
      idempotencyKey: idemKey('plp'),
    });
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    setPriceAmount('');
    void loadPrices(selected);
  }

  /**
   * Remove one item's price from the selected list.
   *
   * Deliberately the WHOLE per-item history in this list rather than the one dated row the operator
   * clicked: that is what makes `price_resolve` fall through to the next scope, and it is what a person
   * looking at a list means by "take this item off it". Retracting a single dated row is the engine's
   * `validFrom` arm and belongs to a price-history editor, which this tab is not yet.
   */
  async function removePrice(row: PriceRow) {
    if (selected === null) return;
    setError(null);
    setPending(null);
    const resp = await client.call('price_lists_unset_price', {
      workspaceId,
      priceListId: selected,
      itemId: row.itemId,
      idempotencyKey: idemKey('plup'),
    });
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    void loadPrices(selected);
  }

  async function removeList(list: PriceList) {
    setError(null);
    setPending(null);
    const resp = await client.call('price_lists_delete', {
      workspaceId,
      priceListId: list.id,
      idempotencyKey: idemKey('pld'),
    });
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    // A price editor pointed at a list that no longer exists would read its rows for ever and get
    // `not_found`, so the selection goes with the list.
    if (selected === list.id) setSelected(null);
    void loadLists();
  }

  async function preview() {
    setError(null);
    setResolveResult(null);
    const resp = await client.call('price_resolve', {
      workspaceId,
      itemId: resolveItemId,
      contactId: resolveContactId.trim() === '' ? undefined : resolveContactId.trim(),
    });
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    const body = resp.body as unknown as { priceMinor: number; currency: string; source: string };
    setResolveResult({ priceMinor: body.priceMinor, currency: body.currency, source: body.source });
  }

  const itemName = new Map(items.map((i) => [i.id, i.name] as const));
  const contactName = new Map(contacts.map((c) => [c.id, c.name] as const));

  /**
   * Why each primary is unavailable, or null when it is ready. One string per precondition (D15/C3),
   * and the FIRST missing one, because a person fixes them in order and three notes at once is noise.
   */
  const createBlocked =
    name.trim() === ''
      ? t('pricelists.needName')
      : scopeValue.trim() === ''
        ? scope === 'contact'
          ? t('pricelists.needContact')
          : t('pricelists.needSegment')
        : null;
  const addPriceBlocked =
    priceItemId === ''
      ? t('pricelists.needItem')
      : parseAmountToMinor(priceAmount) === null
        ? t('pricelists.needAmount')
        : !isIsoDay(validFrom)
          ? t('pricelists.needValidFrom')
          : null;
  const previewBlocked = resolveItemId === '' ? t('pricelists.needResolveItem') : null;

  if (loading) {
    return (
      <div className="pricelists">
        <Skeleton rows={4} height={40} />
      </div>
    );
  }

  if (denied) {
    return (
      <div className="pricelists">
        <PermissionDenied />
      </div>
    );
  }

  return (
    <div className="pricelists">
      {error !== null && <ErrorBanner error={error} message={scopeTakenMessage(error, lists ?? [], t)} />}

      {canManage && (
      <div className="pricelists-create panel">
        <h2 className="item-drawer-title">{t('pricelists.action.create')}</h2>
        <div className="item-row2">
          <label className="item-field-inner">
            <span className="item-field-label">{t('item.name')}</span>
            <input className="item-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="item-field-inner">
            <span className="item-field-label">{t('pricelists.scopeLabel')}</span>
            <select
              className="item-input"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as 'segment' | 'contact');
                // The two arms hold different kinds of value (an id and a free word), so carrying one
                // across would send a segment named after a contact id.
                setScopeValue('');
              }}
            >
              <option value="segment">{t('pricelists.scope.segment')}</option>
              <option value="contact">{t('pricelists.scope.contact')}</option>
            </select>
          </label>
        </div>
        <label className="item-field-inner">
          <span className="item-field-label">
            {scope === 'contact' ? t('pricelists.scope.contact') : t('pricelists.scope.segment')}
          </span>
          {scope === 'contact' && contactsReadable ? (
            <select className="item-input" value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
              <option value="">{t('pricelists.contactNone')}</option>
              {contacts.map((c) => {
                // One scope holds at most one list (F4): offering a contact that already has one would
                // be offering a call the engine refuses with `scope_taken`.
                const taken = listedContactIds.has(c.id);
                return (
                  <option key={c.id} value={c.id} disabled={taken}>
                    {taken ? t('pricelists.contactTaken', { name: c.name }) : c.name}
                  </option>
                );
              })}
            </select>
          ) : (
            <input className="item-input" value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} />
          )}
        </label>
        <div className="pricelists-action">
          <button
            type="button"
            className="btn btn--primary"
            disabled={createBlocked !== null}
            aria-describedby={createBlocked !== null ? `${noteId}-create` : undefined}
            onClick={() => void createList()}
          >
            {t('pricelists.action.create')}
          </button>
          {createBlocked !== null && (
            <span id={`${noteId}-create`} className="item-field-hint">
              {createBlocked}
            </span>
          )}
        </div>
      </div>
      )}

      {lists === null ? null : lists.length === 0 ? (
        <EmptyState title={t('pricelists.empty')} hint={t('pricelists.emptyHint')} />
      ) : (
        <ul className="item-list panel">
          {lists.map((list) => (
            <li key={list.id} className={`item-row${selected === list.id ? ' item-row--selected' : ''}`}>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-pressed={selected === list.id}
                onClick={() => setSelected(selected === list.id ? null : list.id)}
              >
                {list.name}
              </button>
              <span className="item-badge">
                {list.contactId !== undefined && list.contactId !== null
                  ? t('pricelists.scope.contact')
                  : t('pricelists.scope.segment')}
              </span>
              <span className="item-unit">
                {list.segment ??
                  (list.contactId !== undefined && list.contactId !== null
                    ? contactName.get(list.contactId) ?? list.contactId
                    : '')}
              </span>
              {canManage && (
                <span className="item-actions">
                  <OverflowMenu
                    label={t('pricelists.listActions', { name: list.name })}
                    items={[
                      {
                        key: 'delete',
                        label: t('pricelists.action.delete'),
                        onSelect: () => setPending({ kind: 'list', list }),
                        danger: true,
                      },
                    ]}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {selected !== null && (
        <div className="pricelists-prices panel">
          <h2 className="item-drawer-title">{t('pricelists.prices')}</h2>
          {canManage && (
          <>
          <div className="item-row2">
            <label className="item-field-inner">
              <span className="item-field-label">{t('pricelists.item')}</span>
              <select className="item-input" value={priceItemId} onChange={(e) => setPriceItemId(e.target.value)}>
                <option value="">{t('item.itemNone')}</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="item-field-inner">
              <span className="item-field-label">{t('item.field.sales_price')}</span>
              <input
                className="item-input item-num"
                inputMode="decimal"
                placeholder="0.00"
                value={priceAmount}
                onChange={(e) => setPriceAmount(e.target.value)}
              />
            </label>
          </div>
          <label className="item-field-inner">
            <span className="item-field-label">{t('pricelists.field.valid_from')}</span>
            {/*
              A real date picker (D15/C1): the engine takes the bare ISO day and refuses anything else
              rather than coercing it, so the browser's own picker is both the correct input and the
              one that renders in the operator's locale for free.
            */}
            <input
              type="date"
              className="item-input"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </label>
          <div className="pricelists-action">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={addPriceBlocked !== null}
              aria-describedby={addPriceBlocked !== null ? `${noteId}-price` : undefined}
              onClick={() => void addPrice()}
            >
              {t('pricelists.action.setPrice')}
            </button>
            {addPriceBlocked !== null && (
              <span id={`${noteId}-price`} className="item-field-hint">
                {addPriceBlocked}
              </span>
            )}
          </div>
          </>
          )}

          {prices.length === 0 ? (
            <p className="item-field-hint">{t('pricelists.emptyPrices')}</p>
          ) : (
            <ul className="item-list">
              {prices.map((p) => {
                const label = itemName.get(p.itemId) ?? p.itemId;
                return (
                  <li key={p.id} className="item-row">
                    <span className="item-name">{label}</span>
                    <span className="item-price item-num">{formatMoney(p.priceMinor, p.currency)}</span>
                    <span className="item-unit">{formatDate(p.validFrom)}</span>
                    {canManage && (
                      <span className="item-actions">
                        <OverflowMenu
                          label={t('pricelists.rowActions', { name: label })}
                          items={[
                            {
                              key: 'unset',
                              label: t('pricelists.action.unsetPrice'),
                              onSelect: () => setPending({ kind: 'price', row: p, name: label }),
                              danger: true,
                            },
                          ]}
                        />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="pricelists-resolve panel">
        <h2 className="item-drawer-title">{t('pricelists.resolve')}</h2>
        <div className="item-row2">
          <label className="item-field-inner">
            <span className="item-field-label">{t('pricelists.item')}</span>
            <select className="item-input" value={resolveItemId} onChange={(e) => setResolveItemId(e.target.value)}>
              <option value="">{t('item.itemNone')}</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="item-field-inner">
            <span className="item-field-label">{t('pricelists.scope.contact')}</span>
            {contactsReadable ? (
              <select
                className="item-input"
                value={resolveContactId}
                onChange={(e) => setResolveContactId(e.target.value)}
              >
                {/* No contact at all IS a legitimate question: it resolves the base tier. */}
                <option value="">{t('pricelists.contactNone')}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="item-input"
                value={resolveContactId}
                onChange={(e) => setResolveContactId(e.target.value)}
              />
            )}
          </label>
        </div>
        <div className="pricelists-action">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={previewBlocked !== null}
            aria-describedby={previewBlocked !== null ? `${noteId}-resolve` : undefined}
            onClick={() => void preview()}
          >
            {t('pricelists.action.resolve')}
          </button>
          {previewBlocked !== null && (
            <span id={`${noteId}-resolve`} className="item-field-hint">
              {previewBlocked}
            </span>
          )}
        </div>
        {resolveResult !== null && (
          <p className="pricelists-result">
            <span className="item-price item-num">{formatMoney(resolveResult.priceMinor, resolveResult.currency ?? baseCurrency)}</span>
            {/*
              `tStrict`, not `t` (D17): the key is assembled from a value the ENGINE chose, so a future
              precedence tier would otherwise leak a raw `pricelists.source.<x>` dot-path onto the
              screen. A dev white-screen on an unknown source is the cheaper failure.
            */}
            <span className="item-badge">{tStrict(`pricelists.source.${resolveResult.source}`)}</span>
          </p>
        )}
      </div>

      {pending !== null && pending.kind === 'list' && (
        <ConfirmDialog
          message={t('pricelists.confirmDelete', { name: pending.list.name })}
          confirmLabel={t('pricelists.confirmDeleteConfirm')}
          cancelLabel={t('item.cancel')}
          onConfirm={() => void removeList(pending.list)}
          onCancel={() => setPending(null)}
        />
      )}

      {pending !== null && pending.kind === 'price' && (
        <ConfirmDialog
          message={t('pricelists.confirmUnset', { name: pending.name })}
          confirmLabel={t('pricelists.confirmUnsetConfirm')}
          cancelLabel={t('item.cancel')}
          onConfirm={() => void removePrice(pending.row)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

/**
 * The bespoke `scope_taken` sentence, naming the list that is already there.
 *
 * The engine answers `scope_taken` with the EXISTING `priceListId` precisely so the caller can point at
 * it, and the remediation that added the refusal left the surface saying nothing about which list to
 * edit instead. Falls back to the generic mapped message when the id names a list this tab has not
 * loaded, which is the case right after another session created it.
 */
function scopeTakenMessage(
  err: Err,
  lists: PriceList[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string | undefined {
  if (err.error !== 'scope_taken') return undefined;
  const existing = lists.find((l) => l.id === err.priceListId);
  return existing === undefined ? undefined : t('pricelists.error.scope_taken_named', { name: existing.name });
}
