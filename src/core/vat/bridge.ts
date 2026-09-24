/**
 * The A07 Abstimmung bridge, promoted from the Studio (`app/src/surfaces/VatReturn/model.ts`) into the
 * engine so "geprüft" on `/mwst` and the G22 `abstimmung_resolved` check are ONE derivation (spec G22
 * §4). `computeVatReturn` carries the result as `bridge`; the surface consumes the field.
 *
 * It is ONE check rather than the three the A07 design asked for: the engine compares Ziff. 399
 * against the movement on 2200 and sends nothing else, so the whole difference lands in
 * `unexplainedMinor`. On Saldo there is no check at all (`notApplicable`, Art. 37: the VAT invoiced
 * and the VAT owed are different figures by construction) and the drift must not be shown. An empty
 * account name is `noAccount`: an explicit absence, never a fabricated zero.
 *
 * A38 (D129 leg 2): the `bookedMinor` this bridge compares against is `bookedVatByEntry`'s 2200 read
 * in `abrechnung.ts`, which excludes `source='vat_settlement'` entries and their reversals by name. So
 * the year-end MWST-Saldierung, which empties 2200 into 2201 dated the period end INSIDE the filed
 * period, cannot move this bridge: a quarter that read "stimmt überein" before its settlement reads
 * the same after it. The exclusion lives in the one read both consumers share rather than here, so
 * the Studio strip and the G22 `abstimmung_resolved` check cannot disagree about it.
 */

export type VatBridgeKind = 'match' | 'open' | 'notApplicable' | 'noAccount';

export interface VatBridge {
  readonly kind: VatBridgeKind;
  /** The account the engine compared against, for the copy. Empty when it could not find one. */
  readonly account: string;
  readonly returnMinor: number;
  readonly bookedMinor: number;
  /** The part of the difference nothing explains. Zero on a match. */
  readonly unexplainedMinor: number;
}

export interface VatBridgeInput {
  readonly totalTaxDueMinor: number;
  readonly reconciliation: {
    readonly applicable: boolean;
    readonly outputVatAccount: string;
    readonly outputVatBookedMinor: number;
    readonly driftMinor: number;
  };
}

/** Pure: subtraction over two figures the engine already computed, and a reading of two facts. */
export function vatBridgeOf(view: VatBridgeInput): VatBridge {
  const { applicable, outputVatAccount, outputVatBookedMinor, driftMinor } = view.reconciliation;
  const base = { account: outputVatAccount, returnMinor: view.totalTaxDueMinor, bookedMinor: outputVatBookedMinor };
  if (!applicable) return { ...base, kind: 'notApplicable', unexplainedMinor: 0 };
  if (outputVatAccount === '') return { ...base, kind: 'noAccount', unexplainedMinor: 0 };
  if (driftMinor === 0) return { ...base, kind: 'match', unexplainedMinor: 0 };
  return { ...base, kind: 'open', unexplainedMinor: driftMinor };
}
