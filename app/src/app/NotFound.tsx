/**
 * The catch-all route (kaizen K-10): an address the router does not know.
 *
 * Before this component existed the route table had no `*` entry, so any unmatched path (a typo
 * like `/paymnets`, a stale bookmark) raised the router's 404 into `RouteCrash`, the panel that
 * says a screen stopped working. Nothing was broken: the address simply does not exist, and
 * US-G16.9's rule for dead deep links is a detour in plain words, never a crash screen. Like
 * `RouteCrash` and `Placeholder` it is a plain route component inside the Shell, not a registered
 * surface: it has no nav entry, no capability, no help entry.
 */
import { Link } from 'react-router-dom';

import { useT } from '../i18n';
import { NAV_ITEMS } from './nav';

export function NotFound() {
  const t = useT();
  return (
    <section aria-labelledby="surface-title">
      <h1 id="surface-title" className="visually-hidden">
        {t('shell.notFound.title')}
      </h1>
      <div className="state-panel panel">
        <h2 className="state-title">{t('shell.notFound.title')}</h2>
        <p className="state-body">{t('shell.notFound.body')}</p>
        <p>
          <Link className="btn btn--secondary" to={NAV_ITEMS[0].path}>
            {t('shell.notFound.toOverview')}
          </Link>{' '}
          <Link className="btn btn--secondary" to="/setup">
            {t('shell.deeplink.pick')}
          </Link>
        </p>
      </div>
    </section>
  );
}
