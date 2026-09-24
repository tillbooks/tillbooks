/**
 * TILL: Trusted Independent Ledger Library.
 *
 * The public surface of the core. Local-first Swiss accounting, MIT licensed.
 */

export const VERSION = '0.0.0';

export {
  money,
  rappen,
  fromFranken,
  toFranken,
  add,
  subtract,
  negate,
  sum,
  isZero,
  equals,
  format,
  MoneyError,
} from './money.js';

export type { Money, Rappen, Currency } from './money.js';
