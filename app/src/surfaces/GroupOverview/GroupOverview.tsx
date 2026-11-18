/**
 * The area overview (D201, owner 15.11.2026, menu pick A): ONE page of tiles per menu group and per
 * nested parent, at `/area/<navId>`.
 *
 * WHY. A click on a group header in the rail used to land on the group's first page (D135), so a
 * person saw one page of nine and had to open the group to learn what else lived there. Now the click
 * opens this page and expands the group: every page of the area at once, in the full width, with a
 * live search on top (D204 "Find it, then act"). One shared component serves every group and every
 * parent; there is no per-group page.
 *
 * WHAT IT SHOWS. The area's pages in the person's own menu order (the personal tree, so a page they
 * hid stays hidden here too and a page they moved shows where they put it); a nested parent's pages
 * follow under the parent's name. An area the person hid from the menu still opens from a link, read
 * from the canonical tree. A tile is the page's icon, its name and, where a caller can say it
 * cheaply, one short count or state (`states`); no helper sentence (Cognitive load rule 7).
 *
 * THE WAY BACK. A tile navigates with `backState(here, area name)`, so the page it opens shows the
 * SurfaceHeader back chevron to this overview (D201 point 6).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

import { useT } from '../../i18n';
import { SurfaceHeader, backState } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { FilterBar } from '../../components/FilterBar';
import { EmptyState } from '../../components/states';
import { NotFound } from '../../app/NotFound';
import { NavIcon } from '../../app/nav-icons';
import { useRailOptional } from '../../app/nav-prefs';
import { findAreaIn, isNavParent, NAV_RAIL, type AreaNode, type NavIconName, type NavItem } from '../../app/nav';
import './GroupOverview.css';

/** One block of tiles: the area's own pages (no heading), or a nested parent's pages under its name. */
interface TileSection {
  key: string;
  heading: { labelKey: string; icon: NavIconName } | null;
  items: readonly NavItem[];
}

function sectionsOf(area: AreaNode): TileSection[] {
  if (area.kind === 'parent') return [{ key: area.navId, heading: null, items: area.items }];
  const own: NavItem[] = [];
  const nested: TileSection[] = [];
  for (const node of area.items) {
    if (isNavParent(node)) {
      nested.push({ key: node.navId, heading: { labelKey: node.labelKey, icon: node.icon }, items: node.children });
    } else {
      own.push(node);
    }
  }
  return [{ key: area.navId, heading: null, items: own }, ...nested].filter((s) => s.items.length > 0);
}

/** Case- and accent-tolerant match, so "uber" finds "Übersicht" and "MWST" finds "mwst". */
function fold(text: string): string {
  return text.toLocaleLowerCase('de-CH').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface GroupOverviewProps {
  /** The area to show; defaults to the `:groupId` route param. */
  areaId?: string;
  /** One short count or state per page navId ("3 offen"), where a caller can say it cheaply. */
  states?: Readonly<Record<string, string>>;
}

export function GroupOverview({ areaId, states }: GroupOverviewProps) {
  const t = useT();
  const params = useParams();
  const { pathname, search } = useLocation();
  const titleId = useId();
  const id = areaId ?? params.groupId ?? '';
  const personal = useRailOptional()?.rail;
  const area = useMemo(
    () => (personal === undefined ? null : findAreaIn(personal, id)) ?? findAreaIn(NAV_RAIL, id),
    [personal, id],
  );
  const [query, setQuery] = useState('');
  // A new area starts with an empty search: the last area's words do not filter this one.
  useEffect(() => setQuery(''), [id]);

  const sections = useMemo(() => (area === null ? [] : sectionsOf(area)), [area]);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    if (q === '') return sections;
    return sections
      .map((s) => ({ ...s, items: s.items.filter((item) => fold(t(item.labelKey)).includes(q)) }))
      .filter((s) => s.items.length > 0);
  }, [sections, query, t]);

  if (area === null) return <NotFound />;

  const title = t(area.labelKey);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const from = backState(`${pathname}${search}`, title);

  return (
    <section className="group-overview" aria-labelledby={titleId}>
      <SurfaceHeader
        title={title}
        titleId={titleId}
        count={total}
        help={<SurfaceHelp surface="GroupOverview" />}
        toolbar={
          <FilterBar
            searchValue={query}
            onSearchChange={setQuery}
            searchLabel={t('groupOverview.search', { area: title })}
            searchPlaceholder={t('groupOverview.searchPlaceholder')}
          />
        }
      />
      {shown.length === 0 ? (
        <EmptyState filtered={{ onClear: () => setQuery('') }} />
      ) : (
        shown.map((section) => {
          const label = section.heading === null ? title : t(section.heading.labelKey);
          return (
            <div key={section.key} className="group-overview-section">
              {section.heading !== null && (
                <h2 className="group-overview-heading">
                  <NavIcon name={section.heading.icon} size={16} />
                  <span>{label}</span>
                </h2>
              )}
              <ul className="group-overview-grid" aria-label={label}>
                {section.items.map((item) => (
                  <li key={item.navId}>
                    <Link className="group-tile panel panel--interactive" to={item.path} state={from}>
                      <span className="group-tile-top">
                        <span className="group-tile-icon" aria-hidden="true">
                          <NavIcon name={item.icon ?? 'overview'} size={20} />
                        </span>
                        {states?.[item.navId] !== undefined && (
                          <span className="group-tile-state t-num">{states[item.navId]}</span>
                        )}
                      </span>
                      <span className="group-tile-name">{t(item.labelKey)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

export default GroupOverview;
