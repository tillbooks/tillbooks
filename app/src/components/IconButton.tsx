/**
 * The one icon-only button of the Studio (Ruhig 3, D154).
 *
 * It takes a key of the closed vocabulary and nothing else, so a glyph that is not in DESIGN.md's
 * "Icon vocabulary" cannot stand alone, and a money commit or a destructive act cannot become a glyph:
 * neither has a key. The vocabulary name ("Anhängen") is the accessible name and the tooltip's first
 * line; `context` ("Beleg zu dieser Buchung") is the tooltip's second line and the button's
 * description, so a screen reader hears "Anhängen, Beleg zu dieser Buchung" and never the name twice.
 *
 * The tooltip is the shared `Tooltip`: it opens on hover, on keyboard focus and on a 450ms long press
 * on touch (which then does not also click), and closes on Escape, blur or pointer leave.
 */
import { useId, type ButtonHTMLAttributes } from 'react';

import { VOCABULARY, type VocabularyIcon } from './icons/vocabulary';
import type { IconSize } from './icons/base';
import { Tooltip } from './Tooltip';
import './IconButton.css';

type NativeButton = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'title' | 'type'
>;

export interface IconButtonProps extends NativeButton {
  /** The vocabulary key. Its name becomes the accessible name. */
  icon: VocabularyIcon;
  /** What the act applies to, in a few words: the tooltip's second line and the description. */
  context: string;
  /**
   * The accessible name and the tooltip's first line, when the act is more specific than the
   * vocabulary word: the check that saves a named view says "Ansicht speichern", not "Fertig" (D180).
   * The glyph and its meaning stay the vocabulary's; omit it everywhere else.
   */
  name?: string;
  /** Glyph size; DESIGN.md allows 16, 20 and 24. */
  size?: IconSize;
  /** Where the tooltip sits. Defaults to above. */
  placement?: 'top' | 'bottom';
  /** `submit` only for the rare icon that submits its form; everything else stays `button`. */
  type?: 'button' | 'submit';
  /** The 32px dense-row target (`btn--sm`) instead of the 36px one. */
  small?: boolean;
}

export function IconButton({
  icon,
  context,
  size = 16,
  placement = 'top',
  type = 'button',
  small = false,
  className,
  name: nameOverride,
  ...rest
}: IconButtonProps) {
  const descriptionId = useId();
  const { name: vocabularyName, glyph: Glyph } = VOCABULARY[icon];
  const name = nameOverride ?? vocabularyName;
  return (
    <Tooltip
      placement={placement}
      descriptionId={descriptionId}
      content={
        <>
          <span className="tooltip-name">{name}</span>
          <span className="tooltip-context" id={descriptionId}>
            {context}
          </span>
        </>
      }
    >
      <button
        {...rest}
        type={type}
        className={['btn', 'btn--ghost', 'btn--icon', small ? 'btn--sm' : '', 'icon-button', className ?? '']
          .filter(Boolean)
          .join(' ')}
        aria-label={name}
        data-icon={icon}
      >
        <Glyph size={size} />
      </button>
    </Tooltip>
  );
}
