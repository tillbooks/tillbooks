/**
 * B03 §H-ENUM: the single source for the costing read model's closed enumerations.
 *
 * TWO ENUMS AND ONE HONESTY LIST, nothing else. `COSTING_COMPONENTS` is the drilldown vocabulary
 * and the anti-double-count model itself (spec §6b Fixed: the split may never be regrouped, because
 * regrouping it is how a Rappen gets counted twice or not at all). `COSTING_BASES` names the two
 * ways a time slice is valued; which rate resolves each basis is OP1's single resolver, never a
 * third basis smuggled in through a parameter.
 *
 * `UNATTRIBUTABLE_COMPONENTS` is the B00 empty-cost-seam posture applied to B03 (spec §0): a
 * component sits here exactly while its source table cannot attribute rows to a project, so a
 * structural zero never masquerades as a measurement. The list is EMPTY since the project cost
 * dimension landed: `vendor_bill.project_id` feeds expenses/purchases, `po_line.project_id` feeds
 * accrued_purchases/committed, and each component left this list in the commit that wired its
 * query (the contract the pre-landing docblock promised). The list itself survives as the payload
 * vocabulary, so a future component with an unlanded source re-enters it rather than inventing a
 * second mechanism.
 */

export const COSTING_COMPONENTS = [
  'time',
  'expenses',
  'purchases',
  'accrued_purchases',
  'committed',
  'revenue',
] as const;
export type CostingComponent = (typeof COSTING_COMPONENTS)[number];

export function isCostingComponent(value: unknown): value is CostingComponent {
  return typeof value === 'string' && (COSTING_COMPONENTS as readonly string[]).includes(value);
}

export const COSTING_BASES = ['bill', 'cost'] as const;
export type CostingBasis = (typeof COSTING_BASES)[number];

export function isCostingBasis(value: unknown): value is CostingBasis {
  return typeof value === 'string' && (COSTING_BASES as readonly string[]).includes(value);
}

/**
 * The components no landed source table can attribute to a project. EMPTY: `expenses`/`purchases`
 * ride the landed A17 `vendor_bill.project_id`, `accrued_purchases`/`committed` the landed D02
 * `po_line.project_id` (a receipt line attributes through its `po_line_id`, one tag and no copy
 * that could drift).
 */
export const UNATTRIBUTABLE_COMPONENTS: readonly CostingComponent[] = [];
