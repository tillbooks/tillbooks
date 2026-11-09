/**
 * Status: one state word with its glyph (K-22, D137).
 *
 * The same "Bezahlt" used to come in six glyph systems (an SVG check, a grey chip, a weight change,
 * text dingbats, a Mac command glyph, the accent on a chip) across 66 badge classes. This is the one
 * way to show a record's state:
 *
 *   - **A 14px glyph from the icon set, then the word.** The glyph's SHAPE carries the state (a check,
 *     an exclamation, a cross, a clock, a dash, an empty circle), so a colour-blind reader and a
 *     grayscale printout read the same as everyone else. Never colour alone, never a dingbat.
 *   - **Colour only where it means something.** `success`, `warn` and `danger` tint the GLYPH with
 *     `--t-success`, `--t-warn`, `--t-danger` (good, needs attention, bad). Everything else is neutral
 *     ink. The word itself stays in the text ink in every state, so a table of statuses reads calm and
 *     a red word never shouts across a ledger (the money law: danger in the sign or a glyph, never a
 *     filled red row).
 *   - **Never the accent, never a chip.** The accent marks focus, selection and the one primary action;
 *     a state is none of those. A chip is for a number, not a word.
 *
 * It is plain inline text, not a live region: a status in a table cell is read with its row, not
 * announced on its own.
 */
import type { ComponentType, SVGProps } from 'react';

import {
  StatusDangerGlyph,
  StatusInactiveGlyph,
  StatusNeutralGlyph,
  StatusPendingGlyph,
  StatusSuccessGlyph,
  StatusWarnGlyph,
} from './icons';
import './Status.css';

/**
 * The six states a record can be in, by what they ask of the reader:
 *   - `success`  done and good: paid, posted, accepted, completed.
 *   - `warn`     needs attention: overdue, due soon, awaiting approval, partially paid.
 *   - `danger`   failed or refused: rejected, failed, blocked.
 *   - `neutral`  a state with nothing to act on yet: draft, open, new.
 *   - `pending`  under way or scheduled: sent, running, planned.
 *   - `inactive` out of play: archived, paused, ended, cancelled.
 */
export type StatusKind = 'success' | 'warn' | 'danger' | 'neutral' | 'pending' | 'inactive';

const GLYPH: Record<StatusKind, ComponentType<SVGProps<SVGSVGElement> & { size?: number }>> = {
  success: StatusSuccessGlyph,
  warn: StatusWarnGlyph,
  danger: StatusDangerGlyph,
  neutral: StatusNeutralGlyph,
  pending: StatusPendingGlyph,
  inactive: StatusInactiveGlyph,
};

export interface StatusProps {
  /** Which of the six states. Decides the glyph and whether it takes a status colour. */
  kind: StatusKind;
  /** The state word, already translated and humanized ("Bezahlt", never `paid`). */
  label: string;
  /** An extra class, for layout only. */
  className?: string;
}

/** The glyph size, fixed: a status reads the same in every table and every density. */
export const STATUS_GLYPH_SIZE = 14;

export function Status({ kind, label, className }: StatusProps) {
  const Glyph = GLYPH[kind];
  return (
    <span
      className={className === undefined ? 'status-word' : `status-word ${className}`}
      data-kind={kind}
    >
      <Glyph className="status-word-glyph" size={STATUS_GLYPH_SIZE} />
      <span className="status-word-label">{label}</span>
    </span>
  );
}
