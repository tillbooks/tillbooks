/**
 * The ONE drawer shell A19 renders, for every drawer on the surface: now a thin adoption of the
 * shared `DetailDrawer` primitive (D118 B2).
 *
 * WHY IT IS ITS OWN FILE (F6). It used to be a private helper inside `BankAccountEditor.tsx`, so the
 * opening-balance step launched from a ROW could not reach it and hand-rolled the overlay and the
 * panel instead. The copy was visually identical, carried the same title and hosted the same step,
 * and differed in exactly one invisible way: the shell owns the `Escape` listener and the copy did
 * not. One job, one component: "the same component for the same job, no two visual answers to the
 * same problem". Keeping this wrapper preserves that single seam while the layout, the focus trap and
 * the scrim behaviour move to the shared primitive, so the editor and the row-launched step still
 * pass through exactly one shell.
 *
 * WHAT THE PRIMITIVE NOW OWNS, that this file used to hand-roll: the right-side scrim, the panel, the
 * fixed header over an independently scrolling body, the `Escape`-closes / scrim-closes / inside-click
 * does-not convention, and a real focus trap (`useFocusTrap`) that returns focus to the row that
 * opened it: the bespoke shell had the Escape listener but no trap. The dialog role sits on a `div`
 * inside `DetailDrawer`, which `test/style/modal-role-on-allowed-element.test.mjs` still guards; this
 * file names no role at all, so there is nothing here for that scan to walk back from.
 */
import { type ReactNode } from 'react';

import { DetailDrawer } from '../../components/DetailDrawer';
import { useT } from '../../i18n';

export interface BankDrawerProps {
  /** The accessible name AND the visible heading: one string, so the two can never disagree. */
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function BankDrawer({ title, onClose, children }: BankDrawerProps) {
  const t = useT();
  return (
    <DetailDrawer open onClose={onClose} title={title} closeLabel={t('bank.close')}>
      {children}
    </DetailDrawer>
  );
}
