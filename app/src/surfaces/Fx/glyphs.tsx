/**
 * A22's own small glyphs: the direction marks on an unrealised difference.
 *
 * A gain and a loss are never told apart by colour alone (DESIGN.md, and the brand law's separate
 * money-colour rule): each figure carries a glyph AND a sign AND a label. The glyph is drawn in
 * `currentColor`, so the loss inherits the danger colour on the sign it sits beside and the gain
 * inherits the normal text colour, and each carries an `aria-label` because it is meaning, not
 * decoration. No hex, ever.
 */
import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number; label: string };

function frame({ size = 14, label, ...rest }: Props) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    role: 'img',
    'aria-label': label,
    ...rest,
  };
}

/** An unrealised GAIN: an up-and-to-the-right mark. Inherits the normal text colour, never emerald. */
export function GainGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <path d="M4 17L10 11l4 4 6-8" />
      <path d="M20 12V7h-5" />
    </svg>
  );
}

/** An unrealised LOSS: a down-and-to-the-right mark. Inherits the danger colour from its cell. */
export function LossGlyph(props: Props) {
  return (
    <svg {...frame(props)}>
      <path d="M4 7l6 6 4-4 6 8" />
      <path d="M20 12v5h-5" />
    </svg>
  );
}
