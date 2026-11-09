/**
 * Copy one short, exact string to the clipboard, and say so.
 *
 * Built for the QR payment reference (A11-G16), which is the one value on the invoice detail a human
 * RETYPES: into an e-banking field, digit by digit, where a slip misroutes a real payment. It is
 * general on purpose, because the same job turns up on every identifier this app shows.
 *
 * Three things it deliberately does NOT do:
 *
 *  - It does not format. The caller passes the value the DESTINATION wants; the display form beside
 *    it (grouped in fives, per SIX IG) is for reading and would be wrong in a bank field.
 *  - It does not claim a copy it did not make. `navigator.clipboard` is absent in an insecure context
 *    and can be refused by permission, so the failure path says so rather than flashing "Kopiert"
 *    over nothing.
 *  - It does not announce through a live region it owns. The confirmation replaces the button's own
 *    accessible name, which is already what a screen reader is focused on.
 */
import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';

export interface CopyButtonProps {
  /** The exact string that lands on the clipboard. Unformatted: see the note above. */
  value: string;
  /**
   * Accessible name for the trigger, e.g. "Copy the payment reference". Defaults to the generic one,
   * which is fine when the value's own label sits immediately beside it.
   */
  label?: string;
}

type Outcome = 'idle' | 'copied' | 'failed';

/** How long the confirmation stays before the button returns to its resting label. */
const SETTLE_MS = 2000;

export function CopyButton({ value, label }: CopyButtonProps) {
  const t = useT();
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A state update after unmount is a React warning and, on a surface that reloads under the user,
  // a real leak of a timer nobody owns any more.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function settle(next: Outcome) {
    setOutcome(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome('idle'), SETTLE_MS);
  }

  async function copy() {
    try {
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard === undefined) {
        settle('failed');
        return;
      }
      await clipboard.writeText(value);
      settle('copied');
    } catch {
      settle('failed');
    }
  }

  const text =
    outcome === 'copied' ? t('copy.copied') : outcome === 'failed' ? t('copy.failed') : t('copy.action');

  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm copy-button"
      aria-label={outcome === 'idle' ? (label ?? t('copy.action')) : text}
      onClick={() => void copy()}
    >
      {text}
    </button>
  );
}
