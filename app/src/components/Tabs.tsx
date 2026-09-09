/**
 * Tabs: the one WAI-ARIA tablist for the Studio (D118 B2).
 *
 * The three shipped tab strips disagreed: the ContactDrawer had the full roving-tabindex model, the
 * Journal and Payments strips had `role="tab"` but no arrow keys and no `aria-controls`, and the
 * Items strip used `aria-pressed` toggle buttons instead of tabs. This settles it on the APG tablist:
 * roving tabindex (one Tab stop), arrow keys with wraparound, Home/End, `aria-selected`, and each tab
 * wired to its panel by `aria-controls` / `aria-labelledby`.
 *
 * Activation is AUTOMATIC (selection follows focus): the panels here are cheap to render, and the APG
 * recommends automatic activation unless revealing a panel is expensive. All panels stay mounted with
 * the inactive ones `hidden`, so `aria-controls` always resolves and a form inside a panel keeps its
 * state when the user tabs away and back.
 *
 * Controlled: the caller owns `activeId` and switches on `onChange`.
 */
import { useId, useRef, type ReactNode } from 'react';

import './Tabs.css';

export interface TabItem {
  /** Stable identifier; the React key and the base of the tab/panel element ids. */
  id: string;
  /** The tab label, already translated by the caller. */
  label: string;
  /** The panel content shown when this tab is active. */
  panel: ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  /** The active tab id, owned by the caller. */
  activeId: string;
  /** Called with the id of the tab the user moved to. */
  onChange: (id: string) => void;
  /** The accessible name for the tablist. */
  label: string;
}

export function Tabs({ tabs, activeId, onChange, label }: TabsProps) {
  const base = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => `${base}-panel-${id}`;

  const move = (currentIndex: number, delta: number) => {
    const count = tabs.length;
    const nextIndex = (currentIndex + delta + count) % count;
    const next = tabs[nextIndex];
    if (next === undefined) return;
    onChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
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
    <div className="tabs">
      <div className="tabs-list" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
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
      {tabs.map((tab) => {
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
      })}
    </div>
  );
}
