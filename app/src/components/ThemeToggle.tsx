/**
 * The theme toggle: one icon button that flips light and dark.
 *
 * It shows the glyph of the theme it switches TO (a sun in dark mode, a moon in light), which reads
 * as "tap to go there". It is an icon-only control, so it carries an `aria-label` and a real
 * inline-SVG glyph, never emoji. `aria-pressed` exposes the dark state to assistive tech.
 */
import { useTheme } from '../app/theme';
import { useT } from '../i18n';
import { MoonGlyph, SunGlyph } from './icons';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const t = useT();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={t('theme.toggle')}
      aria-pressed={isDark}
    >
      {isDark ? <SunGlyph /> : <MoonGlyph />}
    </button>
  );
}
