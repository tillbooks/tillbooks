/**
 * ItemEditor, the create/edit overlay for a single item (D00 §6, extending A09's US-A09.2).
 *
 * Collects the A09 fields (name, sales price in CHF stored as integer Rappen via P2, currency, a
 * default VAT code from A05, a revenue account restricted to A01 income accounts) plus the D00
 * products/items master fields: SKU, kind (product/service), unit (the ITEM_UNITS enum), cost price,
 * category, and the stock dials (track_stock + reorder point). A variant preselects and inherits its
 * parent's defaults (the engine copies them at creation). Create calls `create_item`; edit calls
 * `update_item` with a patch. Structured rejections surface inline on their field, never as a raw
 * stack trace (spec §6 error state).
 */
import { useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import type { Err } from '../../lib/client';
import {
  CURRENCIES,
  ITEM_KINDS,
  ITEM_UNITS,
  idemKey,
  isIncomeAccount,
  milliToQtyInput,
  minorToInput,
  parseAmountToMinor,
  parseQtyToMilli,
  type Account,
  type Category,
  type Item,
  type VatCode,
} from './model';

export interface ItemEditorProps {
  mode: 'create' | 'edit';
  workspaceId: string;
  accounts: Account[];
  vatCodes: VatCode[];
  categories: Category[];
  /** The item being edited. Ignored in create mode. */
  item?: Item;
  /** When set, create mode is creating a VARIANT of this parent (D00 US-D00.2). */
  variantOf?: Item;
  baseCurrency: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ItemEditor({
  mode,
  workspaceId,
  accounts,
  vatCodes,
  categories,
  item,
  variantOf,
  baseCurrency,
  onClose,
  onSaved,
}: ItemEditorProps) {
  const t = useT();
  const client = useClient();
  // A stable namespace for the field error ids (`${titleId}-name-err`, wired via aria-describedby).
  // The drawer's own title/labelledby wiring is the shared DetailDrawer's job now.
  const titleId = useId();

  // The overlay, its scrim, the focus trap (Tab cannot walk out to the catalog behind the scrim),
  // Escape-to-close and focus-restore are all the shared DetailDrawer's now (D118 B2). This component
  // owns only the form; DetailDrawer uses the same `useFocusTrap` the bespoke drawer used to.

  // A new variant seeds its editable fields from the parent so the operator sees the inherited values;
  // the engine snapshots them regardless of what is sent.
  const seed = mode === 'edit' ? item : variantOf;

  const [name, setName] = useState(mode === 'edit' ? item?.name ?? '' : '');
  const [sku, setSku] = useState(mode === 'edit' ? item?.sku ?? '' : '');
  const [kind, setKind] = useState(seed?.kind ?? '');
  const [price, setPrice] = useState(seed !== undefined ? minorToInput(seed.defaultUnitPriceMinor) : '');
  const [costPrice, setCostPrice] = useState(
    seed !== undefined && seed.costPriceMinor !== undefined && seed.costPriceMinor !== null
      ? minorToInput(seed.costPriceMinor)
      : '',
  );
  const [currency, setCurrency] = useState(seed?.currency ?? baseCurrency);
  const [taxCode, setTaxCode] = useState(seed?.defaultTaxCode ?? '');
  const [revenueAccountId, setRevenueAccountId] = useState(seed?.revenueAccountId ?? '');
  const [unit, setUnit] = useState(seed?.unit ?? '');
  const [categoryId, setCategoryId] = useState(seed?.categoryId ?? '');
  const [trackStock, setTrackStock] = useState(seed?.trackStock === true);
  const [reorderPoint, setReorderPoint] = useState(
    seed !== undefined && seed.reorderPointQty !== undefined && seed.reorderPointQty !== null
      ? milliToQtyInput(seed.reorderPointQty)
      : '',
  );

  const [nameError, setNameError] = useState<string | null>(null);
  const [skuError, setSkuError] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [costPriceError, setCostPriceError] = useState<string | null>(null);
  const [taxError, setTaxError] = useState<string | null>(null);
  const [revenueError, setRevenueError] = useState<string | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [formError, setFormError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  const incomeAccounts = accounts.filter(isIncomeAccount);
  const isService = kind === 'service';

  // A09 stored `unit` as free text and D00 narrowed it to ITEM_UNITS, so an item written before that
  // can hold a word the picker does not offer. Rendering it as its own option is what makes the
  // narrowing visible instead of destructive: without it the controlled select matches nothing and
  // draws BLANK, so the operator cannot see what the item is quantified in and cannot tell that
  // saving would leave it alone. The engine accepts the value back unchanged (it validates `unit`
  // only when a write CHANGES it), and picking any real option migrates the row for good.
  const legacyUnit = unit !== '' && !(ITEM_UNITS as readonly string[]).includes(unit) ? unit : null;

  async function handleSave() {
    setNameError(null);
    setSkuError(null);
    setPriceError(null);
    setCostPriceError(null);
    setTaxError(null);
    setRevenueError(null);
    setStockError(null);
    setFormError(null);

    const trimmedName = name.trim();
    const priceMinor = parseAmountToMinor(price);
    const costMinor = costPrice.trim() === '' ? null : parseAmountToMinor(costPrice);
    const reorderMilli = reorderPoint.trim() === '' ? null : parseQtyToMilli(reorderPoint);
    let invalid = false;
    if (trimmedName === '') {
      setNameError(t('item.nameRequired'));
      invalid = true;
    }
    if (priceMinor === null) {
      setPriceError(t('item.priceRequired'));
      invalid = true;
    }
    // On the EINSTANDSPREIS field, not on the Verkaufspreis. It used to call `setPriceError`, so a bad
    // cost price correctly blocked the save and then pointed at a control the operator had typed
    // nothing wrong into, which is exactly what D15/C3 exists to prevent: the reason belongs beside
    // the field that caused it.
    if (costPrice.trim() !== '' && costMinor === null) {
      setCostPriceError(t('item.costPriceRequired'));
      invalid = true;
    }
    if (invalid || priceMinor === null) return;

    setSaving(true);

    const common = {
      sku: sku.trim() === '' ? null : sku.trim(),
      kind: kind === '' ? null : kind,
      currency,
      defaultTaxCode: taxCode === '' ? null : taxCode,
      revenueAccountId: revenueAccountId === '' ? null : revenueAccountId,
      unit: unit === '' ? null : unit,
      categoryId: categoryId === '' ? null : categoryId,
      costPriceMinor: costMinor,
      trackStock: isService ? false : trackStock,
      reorderPointQty: reorderMilli,
    };

    if (mode === 'create') {
      const resp = await client.call('create_item', {
        workspaceId,
        name: trimmedName,
        defaultUnitPriceMinor: priceMinor,
        ...common,
        sku: common.sku ?? undefined,
        variantOfId: variantOf?.id,
        idempotencyKey: idemKey('item'),
      });
      if (isErr(resp.body)) {
        finishError(resp.body);
        return;
      }
    } else {
      const itemId = item?.id;
      if (itemId === undefined) {
        setSaving(false);
        return;
      }
      const resp = await client.call('update_item', {
        workspaceId,
        itemId,
        patch: { name: trimmedName, defaultUnitPriceMinor: priceMinor, ...common },
      });
      if (isErr(resp.body)) {
        finishError(resp.body);
        return;
      }
    }

    setSaving(false);
    onSaved();
    onClose();
  }

  function finishError(err: Err) {
    setSaving(false);
    if (err.error === 'invalid_revenue_account') setRevenueError(t('item.invalidRevenueAccount'));
    else if (err.error === 'unknown_tax_code') setTaxError(t('item.unknownTaxCode'));
    else if (err.error === 'sku_taken') setSkuError(t('item.error.sku_taken'));
    // The engine has a distinct code per money field, so each one lands on its own control rather than
    // all three arriving as one banner the operator has to guess at (D15/C3).
    else if (err.error === 'invalid_price') setPriceError(t('errors.invalid_price'));
    else if (err.error === 'invalid_cost_price') setCostPriceError(t('errors.invalid_cost_price'));
    else if (err.error === 'invalid_reorder_point') setStockError(t('errors.invalid_reorder_point'));
    else if (err.error === 'services_not_stockable') setStockError(t('item.error.services_not_stockable'));
    else if (err.error === 'stock_on_hand_nonzero') setStockError(t('item.error.stock_on_hand_nonzero'));
    else setFormError(err);
  }

  const title =
    mode === 'edit'
      ? t('item.editTitle')
      : variantOf !== undefined
        ? t('item.createVariantTitle', { name: variantOf.name })
        : t('item.new');

  const footer = (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        {t('item.cancel')}
      </button>
      <button type="button" className="btn btn--primary" disabled={saving} onClick={handleSave}>
        {t('item.save')}
      </button>
    </>
  );

  return (
    <DetailDrawer open onClose={onClose} title={title} closeLabel={t('item.close')} footer={footer}>
      <div className="item-form">
        {formError !== null && <ErrorBanner error={formError} />}

          <div className="item-field">
            <label className="item-field-inner">
              <span className="item-field-label">{t('item.name')}</span>
              <input
                className="field"
                value={name}
                aria-invalid={nameError !== null}
                aria-describedby={nameError !== null ? `${titleId}-name-err` : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {nameError !== null && (
              <span id={`${titleId}-name-err`} className="field-error" role="alert">
                {nameError}
              </span>
            )}
          </div>

          <div className="item-row2">
            <div className="item-field">
              <label className="item-field-inner">
                <span className="item-field-label">{t('item.field.sku')}</span>
                <input
                  className="field"
                  value={sku}
                  aria-invalid={skuError !== null}
                  aria-describedby={skuError !== null ? `${titleId}-sku-err` : undefined}
                  onChange={(event) => setSku(event.target.value)}
                />
              </label>
              {skuError !== null && (
                <span id={`${titleId}-sku-err`} className="field-error" role="alert">
                  {skuError}
                </span>
              )}
            </div>

            <div className="item-field">
              <div className="item-field-inner">
                <span className="item-field-label">{t('item.field.kind')}</span>
                <Select
                  value={kind}
                  onChange={(value) => setKind(value)}
                  options={[
                    { value: '', label: t('item.kindNone') },
                    ...ITEM_KINDS.map((k) => ({ value: k, label: t(`item.kind.${k}`) })),
                  ]}
                  ariaLabel={t('item.field.kind')}
                />
              </div>
            </div>
          </div>

          <div className="item-row2">
            <div className="item-field">
              <label className="item-field-inner">
                <span className="item-field-label">{t('item.field.sales_price')}</span>
                <input
                  className="field item-num"
                  value={price}
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-invalid={priceError !== null}
                  aria-describedby={priceError !== null ? `${titleId}-price-err` : undefined}
                  onChange={(event) => setPrice(event.target.value)}
                />
              </label>
              {priceError !== null && (
                <span id={`${titleId}-price-err`} className="field-error" role="alert">
                  {priceError}
                </span>
              )}
            </div>

            <div className="item-field">
              <label className="item-field-inner">
                <span className="item-field-label">{t('item.field.cost_price')}</span>
                <input
                  className="field item-num"
                  value={costPrice}
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-invalid={costPriceError !== null}
                  aria-describedby={costPriceError !== null ? `${titleId}-cost-err` : undefined}
                  onChange={(event) => setCostPrice(event.target.value)}
                />
              </label>
              {costPriceError !== null && (
                <span id={`${titleId}-cost-err`} className="field-error" role="alert">
                  {costPriceError}
                </span>
              )}
            </div>
          </div>

          <div className="item-row2">
            <div className="item-field">
              <div className="item-field-inner">
                <span className="item-field-label">{t('item.currency')}</span>
                <Select
                  value={currency ?? baseCurrency}
                  onChange={(value) => setCurrency(value)}
                  options={CURRENCIES.map((code) => ({ value: code, label: code }))}
                  ariaLabel={t('item.currency')}
                />
              </div>
            </div>

            <div className="item-field">
              <div className="item-field-inner">
                <span className="item-field-label">{t('item.field.unit')}</span>
                <Select
                  value={unit ?? ''}
                  onChange={(value) => setUnit(value)}
                  options={[
                    { value: '', label: t('item.unitNone') },
                    ...(legacyUnit !== null ? [{ value: legacyUnit, label: legacyUnit }] : []),
                    ...ITEM_UNITS.map((u) => ({ value: u, label: t(`item.unit.${u}`) })),
                  ]}
                  ariaLabel={t('item.field.unit')}
                />
              </div>
            </div>
          </div>

          <div className="item-field">
            <div className="item-field-inner">
              <span className="item-field-label">{t('item.taxCode')}</span>
              <Select
                value={taxCode ?? ''}
                onChange={(value) => setTaxCode(value)}
                options={[
                  { value: '', label: t('item.taxNone') },
                  ...vatCodes.map((code) => ({ value: code.code, label: code.label })),
                ]}
                invalid={taxError !== null}
                describedBy={taxError !== null ? `${titleId}-tax-err` : undefined}
                ariaLabel={t('item.taxCode')}
              />
            </div>
            {taxError !== null && (
              <span id={`${titleId}-tax-err`} className="field-error" role="alert">
                {taxError}
              </span>
            )}
          </div>

          <div className="item-field">
            <div className="item-field-inner">
              <span className="item-field-label">{t('item.field.category')}</span>
              <Select
                value={categoryId ?? ''}
                onChange={(value) => setCategoryId(value)}
                options={[
                  { value: '', label: t('item.categoryNone') },
                  ...categories.map((category) => ({ value: category.id, label: category.name })),
                ]}
                ariaLabel={t('item.field.category')}
              />
            </div>
          </div>

          <div className="item-field">
            <div className="item-field-inner">
              <span className="item-field-label">{t('item.revenueAccount')}</span>
              <Select
                value={revenueAccountId ?? ''}
                onChange={(value) => setRevenueAccountId(value)}
                options={[
                  { value: '', label: t('item.revenueNone') },
                  ...incomeAccounts.map((account) => ({
                    value: account.id,
                    label: `${account.number} ${account.name}`,
                  })),
                ]}
                invalid={revenueError !== null}
                describedBy={revenueError !== null ? `${titleId}-rev-err` : undefined}
                ariaLabel={t('item.revenueAccount')}
              />
            </div>
            {revenueError !== null && (
              <span id={`${titleId}-rev-err`} className="field-error" role="alert">
                {revenueError}
              </span>
            )}
          </div>

          {/* Stock dials (D00 US-D00.5): products only. A service disables the toggle rather than
              silently accepting a flag the engine would refuse (services_not_stockable). */}
          <div className="item-field">
            <label className="item-checkbox">
              <input
                type="checkbox"
                checked={trackStock && !isService}
                disabled={isService}
                onChange={(event) => setTrackStock(event.target.checked)}
              />
              <span>{t('item.field.track_stock')}</span>
            </label>
            {isService && <span className="item-field-hint">{t('item.error.services_not_stockable')}</span>}
            {trackStock && !isService && (
              <label className="item-field-inner">
                <span className="item-field-label">{t('item.field.reorder_point_qty')}</span>
                <input
                  className="field item-num"
                  value={reorderPoint}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(event) => setReorderPoint(event.target.value)}
                />
              </label>
            )}
            {stockError !== null && (
              <span className="field-error" role="alert">
                {stockError}
              </span>
            )}
          </div>
      </div>
    </DetailDrawer>
  );
}
