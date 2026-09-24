/**
 * Empty state: says what this is and what to do first, never a bare "No data".
 *
 * THE COPY FORMULA (K-33, D137). Every empty state is three lines, and each has one job:
 *   - the TITLE names what is missing, short, with a full stop: "Noch keine Zahlungen."
 *   - the HINT says, in one sentence under 14 words, when something will appear here;
 *   - the ACTION mirrors the title: "Zahlung erfassen", never "Loslegen".
 * A "begin" sentence with no way to begin is a dead end, which the design law forbids: an empty list
 * offers create. `EmptyState.lint.test.ts` holds the surfaces to it.
 *
 * FILTERED-EMPTY IS A DIFFERENT STATE. When rows exist but the filter hides them all, the list is
 * not empty and creating is the wrong answer: the state says what the filter hides and offers
 * "Filter zurücksetzen". Passing `filtered` gives that state, and it never renders a create action,
 * even when one is passed alongside.
 *
 * The glyph is decorative (the text carries the meaning) and never larger than 24px; the block is
 * left-aligned and replaces the table rather than sitting inside it.
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { InboxGlyph } from './glyphs';

/** An in-place first step (open a drawer, seed a table). */
export interface EmptyActionButton {
  label: string;
  onClick: () => void;
}

/** A first step that lives on another surface, e.g. "set up a workspace" pointing at `/setup`. */
export interface EmptyActionLink {
  label: string;
  to: string;
}

export type EmptyAction = EmptyActionButton | EmptyActionLink;

function isLink(action: EmptyAction): action is EmptyActionLink {
  return 'to' in action;
}

/** The filter that hides every row, and the way back. */
export interface EmptyFilter {
  /** Clear the filter. The state's only action. */
  onClear: () => void;
  /** The action label. Defaults to "Filter zurücksetzen". */
  clearLabel?: string;
}

export interface EmptyStateProps {
  /** Title copy: names what is missing, with a full stop. Defaults to the shared empty title. */
  title?: string;
  /** One sentence under 14 words: when something appears here. Defaults to the shared hint. */
  hint?: string;
  /**
   * The first action, mirroring the title. A handler for an in-place step, a `to` route for a step
   * on another surface. Ignored in the `filtered` state, which never offers create.
   */
  action?: EmptyAction;
  /**
   * The list is empty only because a filter hides everything: the state explains that and offers to
   * clear the filter, never to create. Title and hint default to the shared filtered copy.
   */
  filtered?: EmptyFilter;
}

export function EmptyState({ title, hint, action, filtered }: EmptyStateProps) {
  const t = useT();
  const isFiltered = filtered !== undefined;
  const titleText = title ?? t(isFiltered ? 'states.empty.filteredTitle' : 'states.empty.title');
  const hintText = hint ?? t(isFiltered ? 'states.empty.filteredHint' : 'states.empty.hint');
  // A filtered-empty list offers the way back, never create.
  const shown: EmptyAction | undefined = isFiltered
    ? { label: filtered.clearLabel ?? t('states.empty.clearFilter'), onClick: filtered.onClear }
    : action;
  return (
    <div className="state-panel panel" data-filtered={isFiltered ? '' : undefined}>
      <InboxGlyph className="state-glyph" size={24} />
      <h2 className="state-title">{titleText}</h2>
      <p className="state-body">{hintText}</p>
      {/*
        `btn--secondary`, by owner decision (D21, chosen over an Artifact showing both variants).
        Every state panel (empty and permission-denied alike) wears the same quiet button, and the
        accent stays reserved for the surfaces' own primary actions. The CTA still reads as a real
        control (surface fill, strong border), and since a state panel shows exactly one action,
        prominence relative to siblings is not in play.
      */}
      {shown !== undefined &&
        (isLink(shown) ? (
          <Link className="btn btn--secondary" to={shown.to}>
            {shown.label}
          </Link>
        ) : (
          <button type="button" className="btn btn--secondary" onClick={shown.onClick}>
            {shown.label}
          </button>
        ))}
    </div>
  );
}
