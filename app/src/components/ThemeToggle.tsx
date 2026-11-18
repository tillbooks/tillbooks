/**
 * The theme toggle: one icon button that flips light and dark.
 *
 * It shows the glyph of the theme it switches TO (a sun in dark mode, a moon in light), which reads
 * as "tap to go there". It is an icon-only control, so it carries an `aria-label` and a real
 * inline-SVG glyph, never emoji. `aria-pressed` exposes the dark state to assistive tech.
 *
 * D201/D204 (the shell): every icon-only control names itself on hover and focus, so the button sits
 * in the shared `Tooltip`, the `IconButton` anatomy: the name on the first line, what it does on the
 * second, and only the second line is the button's description (a reader never hears the name twice).
 * It is not an `IconButton` because the theme has no word in the closed icon vocabulary.
 */
import { useId } from 'react';

import { useTheme } from '../app/theme';
import { useT } from '../i18n';
import { MoonGlyph, SunGlyph } from './icons';
import { Tooltip } from './Tooltip';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const t = useT();
  const descriptionId = useId();
  const isDark = theme === 'dark';
  const name = t('theme.toggle');
  return (
    <Tooltip
      descriptionId={descriptionId}
      content={
        <>
          <span className="tooltip-name">{name}</span>
          <span className="tooltip-context" id={descriptionId}>
            {t('theme.toggleContext')}
          </span>
        </>
      }
    >
      <button type="button" className="theme-toggle" onClick={toggle} aria-label={name} aria-pressed={isDark}>
        {isDark ? <SunGlyph /> : <MoonGlyph />}
      </button>
    </Tooltip>
  );
}
