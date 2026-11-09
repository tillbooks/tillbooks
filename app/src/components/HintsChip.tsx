/**
 * HintsChip: a page's notices, folded into one "2 Hinweise" chip beside its title (D187, the owner's
 * pick "Hinweise A").
 *
 * The bordered info boxes stacked above a page's content were the loudest thing on many screens and
 * said the least. They collect here: the chip shows how many there are, and hovering, focusing or
 * clicking it opens a quiet card with each notice's title, its sentence and an optional action.
 *
 * What is NOT a notice: a sentence that says what a booking, a payment, a filing or an export will
 * do. Those stay visible beside their button (the money critic's rule, RECIPE.md "What stays
 * visible"). A notice is context the page can live without at a glance.
 *
 * A disclosure, not a dialog: the chip is a button with `aria-expanded`, the card the region it
 * controls. Hover opens it after a short delay and leaving closes it; a click pins it open until a
 * second click, Escape or a press outside.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useT } from '../i18n';
import { VOCABULARY } from './icons';
import './HintsChip.css';

const InfoGlyph = VOCABULARY.info.glyph;

export interface Hint {
  /** Stable identity, the React key. */
  key: string;
  /** A few words, the notice's point. */
  title: string;
  /** The sentence that explains it. */
  body?: ReactNode;
  /** An optional way to act on it (a link or a button the caller renders). */
  action?: ReactNode;
}

const HOVER_DELAY_MS = 150;

export function HintsChip({ hints }: { hints: readonly Hint[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const cardId = useId();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (hints.length === 0) return null;

  const close = () => {
    setOpen(false);
    setPinned(false);
  };

  return (
    <span
      ref={rootRef}
      className="hints-chip-root"
      onPointerEnter={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY_MS);
      }}
      onPointerLeave={() => {
        window.clearTimeout(timer.current);
        if (!pinned) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        className="hints-chip"
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => {
          if (pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
      >
        <InfoGlyph size={14} />
        {hints.length === 1 ? t('calm.hintsOne') : t('calm.hints', { count: hints.length })}
      </button>
      <div id={cardId} className="hints-card" hidden={!open}>
        {hints.map((hint) => (
          <div key={hint.key} className="hints-card-item">
            <p className="hints-card-title">{hint.title}</p>
            {hint.body !== undefined && <p className="hints-card-body">{hint.body}</p>}
            {hint.action !== undefined && <div className="hints-card-action">{hint.action}</div>}
          </div>
        ))}
      </div>
    </span>
  );
}

export default HintsChip;
