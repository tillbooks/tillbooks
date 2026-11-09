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
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { useT } from '../i18n';
import { HelpGlyph } from './icons';

/** The popover keeps this much clear of every viewport edge, and this much off its trigger. */
const VIEWPORT_MARGIN = 16;
const TRIGGER_GAP = 4;

/**
 * A string body is a sequence of paragraphs separated by a blank line (the catalogues author
 * `"...\n\n..."`). Each becomes its own block, so a long explanation reads as prose and not as one
 * wall. A non-string body (a caller's fragment) is rendered untouched.
 */
function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

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

  // VIEWPORT-SAFE PLACEMENT (UI polish round 2, A3), the inline pattern `Select.tsx` already uses:
  // measure the trigger, pin the popover with `position: fixed` below it (or above, when the room
  // below is short and the room above is not), clamp it 16px inside both side edges, and recompute
  // on scroll (capture, so a scrolling <main> or table frame counts) and resize while open. Fixed
  // positioning is what lets the panel escape `.frame > main { overflow: auto }` and a report's
  // `.rp-table-wrap { overflow-x: auto }`, which clipped it before. The popover STAYS in its DOM
  // position (tab order, Escape and outside-click unchanged); only its box moves. No ancestor of a
  // header or report-table hint carries a transform at rest, so fixed means the viewport here.
  // Under jsdom there is no layout (every rect and offset is 0), so `pos` stays null and the CSS
  // absolute placement applies, exactly as before.
  const [pos, setPos] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || placement === 'center') {
      setPos(null);
      return undefined;
    }
    const compute = (): void => {
      const trigger = triggerRef.current;
      const dialog = dialogRef.current;
      if (trigger === null || dialog === null) return;
      if (dialog.offsetWidth === 0 && dialog.offsetHeight === 0) return; // no layout engine (jsdom)
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = dialog.offsetWidth;
      const height = dialog.offsetHeight;
      const roomBelow = vh - r.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
      const roomAbove = r.top - TRIGGER_GAP - VIEWPORT_MARGIN;
      const fitsBelow = height <= roomBelow;
      const fitsAbove = height <= roomAbove;
      const placeBelow =
        placement === 'bottom' ? fitsBelow || roomBelow >= roomAbove : !(fitsAbove || roomAbove >= roomBelow);
      let left = r.left;
      if (left + width > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - width;
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
      const maxHeight = Math.max(120, placeBelow ? roomBelow : roomAbove);
      setPos(
        placeBelow
          ? { position: 'fixed', top: r.bottom + TRIGGER_GAP, bottom: 'auto', left, maxHeight }
          : { position: 'fixed', bottom: vh - r.top + TRIGGER_GAP, top: 'auto', left, maxHeight },
      );
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, placement]);

  const caveatId = `${id}-leaves-device`;
  const popover = open && (
    <span
      role="dialog"
      id={id}
      aria-label={title}
      className={`help-popover help-${placement}`}
      ref={dialogRef}
      tabIndex={-1}
      style={pos ?? undefined}
    >
      <span className="help-title">{title}</span>
      {/* Paragraphs are spans, not <p>: the panel legally nests inside an <h1> or a <p> (a marked
          term sits in running text), where a block <p> would be invalid HTML. */}
      <span className="help-body">
        {typeof body === 'string'
          ? splitParagraphs(body).map((paragraph, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={index} className="help-para">
                {paragraph}
              </span>
            ))
          : body}
      </span>
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
        /* The docs link on its own row as a text link, and the offline caveat as a quiet caption
           UNDER it rather than inside it, tied back by aria-describedby so a screen reader still
           hears that the link leaves the device (A3). */
        <span className="help-docs">
          <a
            className="help-link link-inline"
            href={learnMore.href}
            target="_blank"
            rel="noreferrer noopener"
            aria-describedby={caveatId}
          >
            {learnMore.label}
          </a>
          <span id={caveatId} className="help-leaves-device">
            {t('help.leavesDevice')}
          </span>
        </span>
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
