/**
 * The rail footer's one status pill and its menu (K-01, D137).
 *
 * WHY ONE PILL. The footer used to stack six rows (the egress dot, a Live chip beside an environment
 * select and a wrapping "Umgebungen verwalten" link, the feedback button, three icon buttons): 158px
 * of a 900px rail, and with the head it left the tree 500px, so opening one group made the tree
 * scroll on every laptop. The owner's pick: the footer is ONE row, the environment is a single pill
 * ("● Live · main"), and everything that lived beside it moves into the pill's menu. The feedback
 * and theme icon buttons stay in the row next to it (`Shell.tsx`).
 *
 * CALM FOOTER (D204, 16.11.2026): the pill is now a single 8px dot in a 32px icon button; its words
 * ("Live · main") ride the tooltip and the accessible name, and the menu below is unchanged. The
 * collapsed icon strip passes `dotOnly`: the dot stays, the menu waits for the expanded rail.
 *
 * WHAT THE PILL SAYS.
 *   - The dot is the E07 egress state. The shell has no live `egress_status` reader, so it rests on
 *     the honest `local` ("Lokal"; D210 dropped "keine Verbindung", because a saved settlement source can be fetched in the same process). It is never colour alone: the words ride the
 *     pill's accessible name, and the menu opens on the same dot with the words beside it.
 *   - The word is the environment's face (D135, see `EnvironmentIndicator.tsx`): calm "Live" on the
 *     writable local main, the loud orange "Test" on a sandbox, "Gehostet" with a padlock on a served
 *     read-only face. The environment's name follows it.
 *   - With no landscape (a pre-landscape build, a failed read) the pill shows the egress word alone,
 *     so the menu, and the density and collapse items in it, are always reachable.
 *
 * THE MENU, top to bottom: "Umgebungen verwalten" first (DESIGN.md, Navigation), the environments
 * as radio items when there is more than one, then the view items that used to be footer buttons:
 * the density switch (a checkbox item, checked in Kompakt) and "Menü anpassen" (D178 point 6, the menu
 * editor; the Menü header carries the same door). "Navigation einklappen" left the Shell's menu in D201
 * (the rail head carries a visible toggle for it, and one act has one place, D152 rule 3); the item
 * stays only for a caller that passes `onCollapse`. It is the
 * rail's shared menu button (`useMenuButton`), opening upward from the footer.
 */
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useT } from '../i18n';
import { useClient } from '../lib/client-context';
import { Tooltip } from '../components/Tooltip';
import type { EgressIndicatorState } from '../components/EgressIndicator';
import {
  FACE_WORD_KEY,
  environmentFace,
  switchEnvironment,
  useLandscape,
  type EnvironmentFace,
} from '../surfaces/Environments/EnvironmentIndicator';
import { useDensity } from './density';
import { useThemeOptional } from './theme';
import { useRailOptional } from './nav-prefs';
import { useMenuButton } from './useMenuButton';
import { VersionDialog } from '../components/WhatsNew';
import { useWorkspaceId } from './workspace';

interface MenuEntry {
  key: string;
  label: string;
  role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Draw a separator ABOVE this entry. */
  separated?: boolean;
}

export interface RailStatusMenuProps {
  /**
   * Collapse the rail to its icon strip, as a menu item. The Shell no longer passes it since D201 (the
   * rail head's visible toggle is the one place for it); a caller that renders the pill without a rail
   * head may still offer it here.
   */
  onCollapse?: () => void;
  /** The E07 egress state the dot shows. The shell rests on `local` (no live reader is wired). */
  egress?: EgressIndicatorState;
  /** The collapsed strip: the dot and its words only, no menu (the rail clips a popup at 56px). */
  dotOnly?: boolean;
}

export function RailStatusMenu({ onCollapse, egress = 'local', dotOnly = false }: RailStatusMenuProps) {
  const t = useT();
  const client = useClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceId();
  const landscape = useLandscape();
  const { density, toggle: toggleDensity } = useDensity();
  // Read optionally: the menu's own tests mount it without a ThemeProvider, and then it offers no switch.
  const themeCtx = useThemeOptional();
  // D178 point 6: "Menü anpassen" opens the menu editor; absent outside the rail's model (its tests).
  const rail = useRailOptional();
  const [busy, setBusy] = useState(false);
  // O00/O01 (D199): the version line opens What's new, the update command or the Upgrade button.
  const [versionOpen, setVersionOpen] = useState(false);
  const menuId = useId();
  const triggerId = useId();

  const face: EnvironmentFace | null = landscape === null ? null : environmentFace(landscape);
  const egressText = t(`egress.indicator.${egress}`);
  const faceWord = face === null || face === 'missing' ? null : t(FACE_WORD_KEY[face]);
  // `missing` names the engine's own fallback, develop, and the menu note says why.
  const envName = landscape === null ? null : face === 'missing' ? 'develop' : landscape.active;

  const entries: MenuEntry[] = [
    { key: 'manage', label: t('env.indicator.manage'), role: 'menuitem', onSelect: () => navigate('/environments') },
  ];
  if (landscape !== null && landscape.rows.length > 1) {
    for (const row of landscape.rows) {
      entries.push({
        key: `env:${row.name}`,
        label: row.name,
        role: 'menuitemradio',
        checked: row.name === landscape.active,
        disabled: busy,
        onSelect: () => {
          if (row.name === landscape.active) return;
          setBusy(true);
          void switchEnvironment(client, workspaceId, row.name).finally(() => setBusy(false));
        },
      });
    }
  }
  entries.push({
    key: 'density',
    label: t('density.toDense'),
    role: 'menuitemcheckbox',
    checked: density === 'kompakt',
    onSelect: toggleDensity,
    separated: true,
  });
  // D210 (owner, 18.11.2026): light or dark sits beside the density, so the footer row keeps room for the
  // company's name. The collapsed icon strip keeps its own glyph, as it does for the density.
  if (themeCtx !== null) {
    entries.push({
      key: 'theme',
      label: t('theme.darkItem'),
      role: 'menuitemcheckbox',
      checked: themeCtx.theme === 'dark',
      onSelect: themeCtx.toggle,
    });
  }
  if (rail !== null && !rail.customising) {
    entries.push({ key: 'customise', label: t('nav.customise.open'), role: 'menuitem', onSelect: () => rail.setCustomising(true) });
  }
  if (onCollapse !== undefined) {
    entries.push({ key: 'collapse', label: t('nav.collapse'), role: 'menuitem', onSelect: onCollapse });
  }
  entries.push({
    key: 'version',
    label: t('releases.menu', { version: typeof __TILL_VERSION__ === 'string' ? __TILL_VERSION__ : '' }).trim(),
    role: 'menuitem',
    onSelect: () => setVersionOpen(true),
    separated: true,
  });

  const menu = useMenuButton(entries.length);

  const label =
    envName === null
      ? t('shell.status.labelLocal', { egress: egressText })
      : faceWord === null
        ? t('shell.status.labelNoFace', { name: envName, egress: egressText })
        : t('shell.status.label', { face: faceWord, name: envName, egress: egressText });

  // The tooltip's words (the dot alone carries none): "Live · main", or the egress word with no landscape.
  const words =
    envName === null
      ? t('shell.status.local')
      : faceWord === null
        ? envName
        : `${faceWord} · ${envName}`;

  function select(entry: MenuEntry) {
    if (entry.disabled === true) return;
    // Collapsing unmounts this very pill, so focus has nowhere to return: close quietly first.
    if (entry.key === 'collapse') menu.closeQuietly();
    else menu.closeAndRefocus();
    entry.onSelect();
  }

  if (dotOnly) {
    return (
      <Tooltip
        content={
          <>
            <span className="tooltip-name">{words}</span>
            <span className="tooltip-context">{egressText}</span>
          </>
        }
      >
        <span className="rail-env-btn" data-face={face ?? 'none'} role="img" aria-label={label} tabIndex={0}>
          <span className="rail-env-dot" data-egress={egress} aria-hidden="true" />
        </span>
      </Tooltip>
    );
  }

  return (
    <div className="rail-status" ref={menu.rootRef}>
      <Tooltip
        content={
          <>
            <span className="tooltip-name">{words}</span>
            <span className="tooltip-context">{egressText}</span>
          </>
        }
      >
        <button
          type="button"
          id={triggerId}
          ref={menu.triggerRef}
          className="rail-env-btn"
          data-face={face ?? 'none'}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          aria-controls={menu.open ? menuId : undefined}
          onClick={menu.onTriggerClick}
          onKeyDown={menu.onTriggerKeyDown}
        >
          <span className="rail-env-dot" data-egress={egress} aria-hidden="true" />
        </button>
      </Tooltip>

      {menu.open && (
        <div className="ws-switcher-pop ws-switcher-pop--up">
          {/* The status lines sit OUTSIDE role="menu" (a menu owns items and separators only). */}
          <p className="rail-status-line">
            <span className="rail-env-dot" data-egress={egress} aria-hidden="true" />
            <span>{egressText}</span>
          </p>
          {face === 'served' && <p className="rail-status-line">{t('env.indicator.readOnlyServed')}</p>}
          {face === 'missing' && <p className="rail-status-line rail-status-line--warn">{t('env.indicator.missing')}</p>}
          <div
            className="ws-switcher-menu"
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={menu.onMenuKeyDown}
          >
            {entries.map((entry, index) => (
              <MenuRow
                key={entry.key}
                entry={entry}
                itemProps={menu.itemProps(index)}
                onSelect={() => select(entry)}
              />
            ))}
          </div>
        </div>
      )}
      {versionOpen && <VersionDialog onClose={() => setVersionOpen(false)} />}
    </div>
  );
}

function MenuRow({
  entry,
  itemProps,
  onSelect,
}: {
  entry: MenuEntry;
  itemProps: ReturnType<ReturnType<typeof useMenuButton>['itemProps']>;
  onSelect: () => void;
}) {
  return (
    <>
      {entry.separated === true && <div role="separator" className="ws-switcher-sep" />}
      <button
        type="button"
        role={entry.role}
        className="ws-switcher-item ws-switcher-item--single"
        aria-checked={entry.role === 'menuitem' ? undefined : entry.checked === true}
        aria-disabled={entry.disabled === true ? true : undefined}
        onClick={onSelect}
        {...itemProps}
      >
        <span className="ws-switcher-item-name">{entry.label}</span>
        {entry.role !== 'menuitem' && entry.checked === true && (
          <svg className="ws-switcher-item-check" width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </>
  );
}

export default RailStatusMenu;
