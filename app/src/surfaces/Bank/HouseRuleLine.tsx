/**
 * N00 (US-N00.4): the house rule of the selected line's counterparty, under the facts card. The owner sees
 * the convention at the moment it matters, beside the line it is about.
 *
 * The engine decides the match (`hausbuch_notes` with the line's `counterparty`: its IBAN, else its
 * normalised name, the key a Buchungsregel groups by), so the Studio folds nothing itself. Nothing shows
 * when no note matches, when the read is refused, or while it is in flight: a note is guidance, so its
 * absence must never look like a state the person has to handle.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { CAP, useCan } from '../../lib/capabilities';
import type { BankInboxLine } from './model';

export function HouseRuleLine({ line, workspaceId }: { line: BankInboxLine; workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const canRead = useCan(CAP.readMasterData);
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const name = line.counterparty.name;
  const iban = line.counterparty.iban;

  useEffect(() => {
    let live = true;
    setNotes([]);
    if (!canRead || (name === null && iban === null)) return undefined;
    void client
      .call('hausbuch_notes', { workspaceId, counterparty: { name, iban } })
      .then(({ body }) => {
        if (!live || isErr(body)) return;
        setNotes(((body as unknown as { notes?: { id: string; text: string }[] }).notes ?? []).map((n) => ({ id: n.id, text: n.text })));
      })
      // A failed read is no state of the line: the note simply does not show.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, workspaceId, name, iban, canRead]);

  if (notes.length === 0) return null;
  return (
    <section className="bank-house-rule" aria-labelledby={`house-rule-${line.bankTxnId}`}>
      <h3 id={`house-rule-${line.bankTxnId}`} className="bank-house-rule__title">
        {t('bankInbox.houseRule.title')}
      </h3>
      {notes.map((n) => (
        <p key={n.id} className="bank-house-rule__text">
          {n.text}
        </p>
      ))}
      <Link to="/hausbuch" className="link-inline bank-house-rule__link">
        {t('bankInbox.houseRule.open')}
      </Link>
    </section>
  );
}
