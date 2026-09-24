/**
 * Tabs: the one WAI-ARIA tablist for the Studio (D118 B2), and the only home of `role="tab"` (K-11,
 * D137).
 *
 * The three shipped tab strips disagreed: the ContactDrawer had the full roving-tabindex model, the
 * Journal and Payments strips had `role="tab"` but no arrow keys and no `aria-controls`, and the
 * Items strip used `aria-pressed` toggle buttons instead of tabs. This settles it on the APG tablist:
 * roving tabindex (one Tab stop), arrow keys with wraparound, Home/End, `aria-selected`, and each tab
 * wired to its panel by `aria-controls` / `aria-labelledby`.
 *
 * WHICH OF THE THREE "ONE OF N" PRIMITIVES (K-11):
 *   - `Tabs` switches between views OF ONE RECORD OR SURFACE (Adresse / Kontakte / Notizen; Laufend /
 *     Archiv). The selected tab is the tinted pill, the one accent spend on the strip.
 *   - `Segmented` picks one of 2 to 5 sibling VALUES that shape the same view (Monat / Jahr, Liste /
 *     Board). A neutral raise, never the accent. Six or more values are a `Select`.
 *   - `FilterChips` toggles any number of FACETS on and off.
 *
 * Two panel models:
 *   - One panel per tab (`TabItem.panel`): every panel stays mounted with the inactive ones `hidden`,
 *     so `aria-controls` always resolves and a form inside a panel keeps its state when the user tabs
 *     away and back. Activation is AUTOMATIC (selection follows focus), as the APG recommends for
 *     cheap panels.
 *   - One shared panel (`children`): the caller renders the active view itself, as the Journal does
 *     with its live and archive faces. The panel is labelled by the active tab and only the active
 *     tab points at it, so no tab ever controls a panel that another tab names.
 *
 * `orientation="vertical"` is the left-hand list (article categories, report lists): the same
 * contract with `aria-orientation`, the pills stacked in a column beside the panel.
 *
 * Controlled: the caller owns `activeId` and switches on `onChange`.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import './Tabs.css';

export interface TabItem {
  /** Stable identifier; the React key and the base of the tab/panel element ids. */
  id: string;
  /** The tab label, already translated by the caller. */
  label: string;
  /**
   * The panel content shown when this tab is active. Omit it on every tab and pass `children` to
   * `Tabs` instead when the caller renders the active view itself.
   */
  panel?: ReactNode;
}

export type TabsOrientation = 'horizontal' | 'vertical';

export interface TabsProps {
  tabs: TabItem[];
  /** The active tab id, owned by the caller. */
  activeId: string;
  /** Called with the id of the tab the user moved to. */
  onChange: (id: string) => void;
  /** The accessible name for the tablist. */
  label: string;
  /** A row of tabs over the panel (default), or a column beside it. */
  orientation?: TabsOrientation;
  /**
   * The shared panel: the active view, rendered by the caller. When given, the per-tab `panel`
   * content is ignored and this is the one `tabpanel`, labelled by the active tab.
   */
  children?: ReactNode;
}

export function Tabs({
  tabs,
  activeId,
  onChange,
  label,
  orientation = 'horizontal',
  children,
}: TabsProps) {
  const base = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const shared = children !== undefined;

  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => (shared ? `${base}-panel` : `${base}-panel-${id}`);
  // One Tab stop even when `activeId` names no tab (a stale id): the first tab takes it.
  const stopId = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id;

  const move = (currentIndex: number, delta: number) => {
    const count = tabs.length;
    if (count === 0) return;
    const nextIndex = (currentIndex + delta + count) % count;
    const next = tabs[nextIndex];
    if (next === undefined) return;
    onChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        move(-1, 1); // wraps to index 0
        break;
      case 'End':
        event.preventDefault();
        move(0, -1); // wraps to the last
        break;
      default:
        break;
    }
  };

  return (
    <div className={orientation === 'vertical' ? 'tabs tabs--vertical' : 'tabs'}>
      <div
        className="tabs-list"
        role="tablist"
        aria-label={label}
        aria-orientation={orientation === 'vertical' ? 'vertical' : undefined}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={!shared || selected ? panelId(tab.id) : undefined}
              tabIndex={tab.id === stopId ? 0 : -1}
              className={selected ? 'tabs-tab tabs-tab--active' : 'tabs-tab'}
              ref={(node) => {
                tabRefs.current[tab.id] = node;
              }}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {shared ? (
        <div
          role="tabpanel"
          id={panelId(activeId)}
          aria-labelledby={tabId(activeId)}
          tabIndex={0}
          className="tabs-panel"
        >
          {children}
        </div>
      ) : (
        tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tabpanel"
              id={panelId(tab.id)}
              aria-labelledby={tabId(tab.id)}
              tabIndex={0}
              hidden={!selected}
              className="tabs-panel"
            >
              {tab.panel}
            </div>
          );
        })
      )}
    </div>
  );
}
