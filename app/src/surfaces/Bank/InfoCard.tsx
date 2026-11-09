/**
 * The (i) beside a short fact, and the card it opens (B2, the owner's pick of 01.10.2026: "Worte auf
 * Wunsch"). The surface states a value in one line; the equation and the explanation behind it sit
 * here, one hover or one focus away.
 *
 * A card, not a tooltip: it may hold an action ("3 Zeilen offen"), and a tooltip holds plain text only
 * (DESIGN.md "Real tooltips"). So the trigger is a real button with an accessible name, `aria-expanded`
 * and `aria-controls`; hovering or focusing it opens the card, a click opens it too (touch), Escape
 * closes it from anywhere (WCAG 1.4.13) and returns focus to the trigger, and focus moving INTO the
 * card keeps it open so a keyboard reaches the action. Leaving with the pointer closes it after a short
 * delay that re-entering cancels, so the pointer can cross the gap to the card (the BankBand card's
 * mechanics, critic F4 of D143, rebuilt here rather than imported across surfaces).
 */
import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';

import { InfoGlyph } from './glyphs';

/** How long the card waits after the pointer left before it closes. */
const CLOSE_DELAY_MS = 250;

export interface InfoCardProps {
  /** The trigger's accessible name, and the card's group name. */
  label: string;
  children: ReactNode;
  className?: string;
}

export function InfoCard({ label, children, className }: InfoCardProps) {
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  // Escape returns focus to the trigger without reopening the card it just closed.
  const returning = useRef(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (wrap.current !== null && wrap.current.contains(document.activeElement)) return;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      cancelClose();
      setOpen(false);
      if (wrap.current !== null && wrap.current.contains(document.activeElement) && document.activeElement !== trigger.current) {
        returning.current = true;
        trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const onBlur = (event: FocusEvent) => {
    if (wrap.current !== null && event.relatedTarget instanceof Node && wrap.current.contains(event.relatedTarget)) return;
    setOpen(false);
  };

  return (
    <span
      ref={wrap}
      className={`bank-info${className !== undefined ? ` ${className}` : ''}`}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={closeSoon}
      onFocus={() => {
        if (returning.current) {
          returning.current = false;
          return;
        }
        setOpen(true);
      }}
      onBlur={onBlur}
    >
      <button
        ref={trigger}
        type="button"
        className="btn btn--ghost btn--icon btn--sm bank-info__trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setOpen(true)}
      >
        <InfoGlyph size={16} />
      </button>
      <div id={cardId} className="bank-info__card" role="group" aria-label={label} hidden={!open}>
        {children}
      </div>
    </span>
  );
}
