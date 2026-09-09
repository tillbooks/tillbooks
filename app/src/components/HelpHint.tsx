/**
 * A contextual help affordance: a disclosure with a title, a body, and optional structured layers.
 * Because it can hold links, it is a disclosure (a labelled dialog), NOT a tooltip: tooltips must
 * not contain interactive content.
 *
 * EXTENDED FOR G17, never duplicated (design §2c: a second popover beside this one would be two
 * visual answers to one job). The extension adds exactly what the concept panel needs:
 *  - `articles`: statutory citations as a structured list below the body, never inline prose.
 *  - `seeAlso` + `onSeeAlso`: related terms. Choosing one REPLACES the panel content in place (the
 *    caller swaps the props): same panel, no second popover, no history. Esc dismisses to the
 *    ORIGINAL trigger, which this component guarantees by never moving its trigger.
 *  - `placement="center"`: the palette-opened variant, centred because there is no trigger to
 *    anchor to. Same role, same dismissal; focus moves INTO the panel on open and the caller's
 *    `onClose` returns it to the palette's own restore target.
 *  - `trigger={{kind:'term', text}}`: the marked term, a REAL button with a dotted underline and an
 *    accessible name ("Begriff X"), never hover-only (design §4c).
 *  - controlled `open`/`onClose` for the trigger-less centred case.
 *
 * The trigger is icon-only or term-styled, so it carries an `aria-label`. `aria-expanded` and
 * `aria-controls` tie it to the popover, which is dismissed on Escape or a click outside; a
 * dismissal returns focus to the trigger, so a keyboard reader never falls off the end of the page.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useT } from '../i18n';
import { HelpGlyph } from './icons';

/** A related term the panel offers: the corpus key and its localized display term. */
export interface ConceptRef {
  key: string;
  term: string;
}

export interface HelpHintProps {
  /** Accessible name for the trigger, e.g. "Help on VAT" or "Begriff Saldosteuersatz". */
  label: string;
  /** The popover heading. */
  title: string;
  /** The popover body copy. */
  body: ReactNode;
  /** An optional deeper link. Opens in a new tab and is labelled as leaving the device. */
  learnMore?: { href: string; label: string };
  /** Where the popover sits. `center` is the palette-opened variant with no anchoring trigger. */
  placement?: 'top' | 'bottom' | 'center';
  /** Statutory citations, rendered as a structured list below the body (G17 §3a). */
  articles?: readonly string[];
  /** Related terms, at most four (gated upstream). Selection replaces content in place. */
  seeAlso?: readonly ConceptRef[];
  /** Called with the chosen related term's key. The caller swaps title/body/articles/seeAlso. */
  onSeeAlso?: (key: string) => void;
  /** Controlled open state (the trigger-less centred panel, or a caller that must reset content on open). */
  open?: boolean;
  /** Controlled close: Esc, outside click. With a trigger present, focus returns to it; otherwise the caller owns the return. */
  onClose?: () => void;
  /** Controlled open request (the trigger was activated while closed). */
  onOpen?: () => void;
  /** Trigger style: default is the "?" glyph; `term` renders a marked concept term. */
  trigger?: { kind: 'term'; text: string };
  /**
   * The one outward handoff (G17 row 5.1: the A35 dock, prefilled and unsent). Activating it
   * closes the panel in the same tick (row 5.3: two explanation surfaces are never open at once).
   * Callers pass it ONLY when a provider is registered; absent, no handoff DOM exists (row 5.2).
   */
  handoff?: { label: string; onActivate: () => void };
}

export function HelpHint(props: HelpHintProps) {
  const { label, title, body, learnMore, placement = 'bottom', articles, seeAlso, onSeeAlso, trigger, handoff } = props;
  const t = useT();
  const id = useId();
  const controlled = props.open !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? props.open === true : openState;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLSpanElement>(null);

  const close = (returnFocus: boolean) => {
    if (controlled) props.onClose?.();
    else setOpenState(false);
    // Esc returns focus to the ORIGINAL trigger (design §3a): the trigger is where the reader's
    // work is, and seeAlso replacement never moves it. The trigger-less centred variant has no
    // triggerRef, so its caller's onClose owns the return (the palette's restore target).
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The centred (palette-opened) variant has no anchoring trigger to leave focus on, so focus moves
  // into the panel on open; the caller's onClose returns it to the palette's restore target (§12).
  useEffect(() => {
    if (open && placement === 'center') dialogRef.current?.focus();
  }, [open, placement]);

  const popover = open && (
    <span
      role="dialog"
      id={id}
      aria-label={title}
      className={`help-popover help-${placement}`}
      ref={dialogRef}
      tabIndex={-1}
    >
      <span className="help-title">{title}</span>
      <span className="help-body">{body}</span>
      {/* Spans with list roles rather than ul/li: the panel legally nests inside running text
          (a marked term sits in a <p>), and a <ul> inside a <p> is invalid HTML. */}
      {articles !== undefined && articles.length > 0 && (
        <span className="help-articles" role="list" aria-label={t('help.articles')}>
          {articles.map((article) => (
            <span key={article} role="listitem" className="help-article">
              {article}
            </span>
          ))}
        </span>
      )}
      {seeAlso !== undefined && seeAlso.length > 0 && onSeeAlso !== undefined && (
        <span className="help-see-also">
          <span className="help-see-also-label">{t('help.seeAlso')}</span>
          <span className="help-see-also-list">
            {seeAlso.map((ref) => (
              <button
                key={ref.key}
                type="button"
                className="help-see-also-term"
                onClick={() => onSeeAlso(ref.key)}
              >
                {ref.term}
              </button>
            ))}
          </span>
        </span>
      )}
      {learnMore !== undefined && (
        <a className="help-link" href={learnMore.href} target="_blank" rel="noreferrer noopener">
          {learnMore.label}
          <span className="help-leaves-device"> ({t('help.leavesDevice')})</span>
        </a>
      )}
      {handoff !== undefined && (
        <button
          type="button"
          className="help-handoff"
          onClick={() => {
            // Row 5.3: the panel closes in the SAME tick the handoff opens, so two explanation
            // surfaces are never open at once. Focus moves into the dock, so no return here.
            close(false);
            handoff.onActivate();
          }}
        >
          {handoff.label}
        </button>
      )}
    </span>
  );

  // Centred: no trigger at all (the palette was the trigger and is closed by now).
  if (placement === 'center') {
    return (
      <span className="help-hint help-hint--center" ref={wrapRef}>
        {popover}
      </span>
    );
  }

  return (
    <span className="help-hint" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={trigger?.kind === 'term' ? 'concept-term' : 'help-trigger'}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (controlled ? (open ? props.onClose?.() : props.onOpen?.()) : setOpenState((prev) => !prev))}
      >
        {trigger?.kind === 'term' ? trigger.text : <HelpGlyph size={16} />}
      </button>
      {popover}
    </span>
  );
}
