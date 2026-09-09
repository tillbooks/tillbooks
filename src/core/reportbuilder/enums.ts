/**
 * F01 §H-ENUM: the single source for the two closed sets F01 owns, and the cron subset it accepts.
 *
 * `REPORT_FORMATS` and `RUN_STATUS` are validated at the verb boundary, never by a CHECK constraint
 * (the §D0 convention). A new export format is a core capability addition (one line here plus a
 * renderer), not a per-workspace customization: keeping the set single-sourced keeps every renderer's
 * escaping and money-formatting guarantees provable once (§6b Fixed).
 *
 * The FILTER OPERATOR set is derived from a column's `type`, never re-implemented per source: a `cf:`
 * custom-field column reuses OP7's own type, so it filters with exactly the operators its type implies
 * and F01 never grows a second type system (§7).
 */

export const REPORT_FORMATS = ['csv', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportFormat(x: unknown): x is ReportFormat {
  return typeof x === 'string' && (REPORT_FORMATS as readonly string[]).includes(x);
}

export const RUN_STATUS = ['ok', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/**
 * The column types a report source (and a `cf:` custom field, OP7) may carry. This mirrors G00's own
 * field types so a custom-field column is typed and filtered exactly as its definition says.
 */
export const COLUMN_TYPES = [
  'text',
  'number',
  'money',
  'date',
  'bool',
  'select',
  'multiselect',
  'contact_ref',
  'entity_ref',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** The filter operators a column of each type admits. The one place operator validity is decided. */
export const OPERATORS_BY_TYPE: Readonly<Record<ColumnType, readonly string[]>> = {
  text: ['eq', 'neq', 'contains'],
  number: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'],
  money: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte'],
  date: ['eq', 'neq', 'before', 'after', 'on_or_before', 'on_or_after'],
  bool: ['eq'],
  select: ['eq', 'neq', 'in'],
  multiselect: ['contains', 'in'],
  contact_ref: ['eq', 'neq'],
  entity_ref: ['eq', 'neq'],
};

export function operatorsForType(type: ColumnType): readonly string[] {
  return OPERATORS_BY_TYPE[type] ?? ['eq'];
}

export function isOperatorForType(op: unknown, type: ColumnType): boolean {
  return typeof op === 'string' && operatorsForType(type).includes(op);
}
