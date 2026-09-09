/**
 * A placeholder surface for a route that has no real content yet.
 *
 * It reuses the EmptyState primitive: title is the surface's own nav label, the hint says the view
 * arrives with Module 1. A later phase replaces each of these with the real surface.
 */
import { EmptyState } from '../components/states';
import { useT } from '../i18n';

export function Placeholder({ titleKey }: { titleKey: string }) {
  const t = useT();
  return (
    <section aria-labelledby="surface-title">
      <h1 id="surface-title" className="visually-hidden">
        {t(titleKey)}
      </h1>
      <EmptyState title={t(titleKey)} hint={t('states.placeholder.hint')} />
    </section>
  );
}
