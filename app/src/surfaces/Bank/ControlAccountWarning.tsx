/**
 * Prevention at the control (critic A39-11): a leg on a control account, 1100 Debitoren or 2000
 * Kreditoren, moves a receivable or a payable with no invoice or bill behind it. The engine books it
 * with the warning `control_account_leg`; the person reads that BEFORE the commit, with the way that
 * settles an open item instead ("Rechnung" in the target picker).
 */
import { useT } from '../../i18n';
import type { DraftLeg } from './model';
import { CONTROL_ACCOUNT_NUMBERS } from './model';
import type { Lookups } from './lookups';
import { accountLabel } from './lookups';

/** The control accounts the legs touch, as "1100 Forderungen ..." labels. */
export function controlAccountsIn(lookups: Lookups, legs: readonly DraftLeg[]): string[] {
  const hit = new Set<string>();
  for (const leg of legs) {
    const number = lookups.chartById.get(leg.accountId)?.number;
    if (number !== undefined && CONTROL_ACCOUNT_NUMBERS.includes(number)) hit.add(accountLabel(lookups, leg.accountId));
  }
  return [...hit];
}

export function ControlAccountWarning({ lookups, legs }: { lookups: Lookups; legs: readonly DraftLeg[] }) {
  const t = useT();
  const accounts = controlAccountsIn(lookups, legs);
  if (accounts.length === 0) return null;
  return <p className="bank-mode__warn">{t('bankInbox.warning.control_account_leg_before', { account: accounts.join(', ') })}</p>;
}
