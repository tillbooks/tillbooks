/**
 * D156: THE ONE CONSEQUENCE CATALOGUE. What a governed write does, in the words an owner uses, and
 * what you can still do afterwards, in English and de-CH, with how far it can be undone.
 *
 * ONE SOURCE, EVERY FACE. Before D156 the sentence lived in three places that disagreed: the Studio's
 * family sentences (`agent.consequence.*`) and per-verb overrides (`agent.consequenceVerb.*`), the 81
 * English sentences the MCP tool descriptions carried, and `ConsequenceLine` showing the family
 * sentence while `VorschlagCard` showed the override. Now:
 *   - `dialMap.ts` projects this catalogue into `CONSEQUENCE_FOR_ACTION` (the English sentence per verb
 *     that `registry.ts` stamps onto `ActionDef.consequence`, and the MCP description carries);
 *   - `src/api/mcp.ts` also sends both languages and the reversibility as the tool's `_meta`;
 *   - `scripts/generate-command-source.mjs` projects the same resolved entry into
 *     `app/src/lib/command-source.generated.json`, which every Studio surface reads.
 * `test/agent/consequence-parity.test.mjs` holds all of them equal, byte for byte.
 *
 * RESOLUTION: a verb's OWN entry, else its dial family's (`consequenceFor`). A family sentence is the
 * fallback for a verb with nothing more specific to say.
 *
 * THE WRITING RULES (D156, brand/DESIGN.md "Copy voice"), held by the parity test:
 *   - at most two sentences and 220 characters;
 *   - sentence one says what happens, sentence two what you can still do: name the correction, or say
 *     plainly that there is no way back;
 *   - no "irreversible", "immutable" or "unwiderruflich" where a governed way back exists, and no way
 *     back implied where none exists. Every "can", "cannot", "stays" and "reopen" below was checked
 *     against the engine verb it describes;
 *   - a correction is a NEW entry beside an original that stays visible (GeBüV: both stay traceable);
 *     the German word for it is "Korrekturbuchung", never phrased as editing;
 *   - de-CH says "du", uses real umlauts and never `ß`.
 *
 * REVERSIBILITY, one word per entry:
 *   - `reversible`: the act itself can be undone or changed back by a verb (a setting, a soft close,
 *     a membership, an ignored bank line);
 *   - `correctable`: the act stands, and a mistake is fixed by a new linked entry or document (a
 *     correcting entry, a credit note, a reversed payment); nothing is overwritten;
 *   - `final`: there is no way back inside TILL (a send, a year seal, the cutover, a sealed count).
 * The class of every entry is the reviewed class in `docs/planning/reversibility/map.json` (D161), held
 * by `test/agent/dial-covers-d161.test.mjs`; a reversal that a fresh original can follow is `correctable`.
 * The MCP `annotations.destructiveHint` is derived from it: `false` only for a `correctable` write,
 * which is append-only (a correction is a new entry beside the original). A `reversible` write can be
 * changed back but may OVERWRITE state (an IBAN, a role, a rule), and a `final` one has no way back,
 * so both advertise `true` (MCP: `false` means the tool performs only additive updates).
 *
 * This module is pure data: it imports nothing, so `dialMap.ts` can project it without a cycle.
 */

export type Reversibility = 'reversible' | 'correctable' | 'final';

export const REVERSIBILITY_LEVELS: readonly Reversibility[] = ['reversible', 'correctable', 'final'];

/** One consequence, in both Studio locales, with how far it can be undone. */
export interface Consequence {
  readonly en: string;
  readonly 'de-CH': string;
  readonly reversibility: Reversibility;
}

/** The two locales every entry carries. */
export const CONSEQUENCE_LOCALES: readonly ('en' | 'de-CH')[] = ['en', 'de-CH'];

/** The fallback sentence per dial family (one key per A26 `DIAL_CAPABILITIES` entry). */
export const CONSEQUENCE_FOR_FAMILY: Readonly<Record<string, Consequence>> = {
  post: {
    en: 'Books this in your accounts. If it is wrong, you correct it with a new correcting entry; both stay visible.',
    'de-CH': 'Bucht das in deine Buchhaltung. Ist es falsch, korrigierst du es mit einer Korrekturbuchung; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  issue: {
    en: "Issues the document with its number and books it; from then on it can't be edited. You correct it with a credit note or a cancellation, and the original stays on record.",
    'de-CH': 'Stellt das Dokument mit seiner Nummer aus und bucht es; danach lässt es sich nicht mehr ändern. Du korrigierst es mit einer Gutschrift oder stornierst es, das Original bleibt erhalten.',
    reversibility: 'correctable',
  },
  send: {
    en: "Sends it to the recipient. Once it is out, it can't be called back; a correction goes out separately.",
    'de-CH': 'Versendet es an den Empfänger. Ist es draussen, lässt es sich nicht zurückholen; eine Korrektur geht separat hinterher.',
    reversibility: 'final',
  },
  // Verified against A15: the level lives on each INVOICE, and a wrong Mahngebühr is corrected by a
  // correcting entry on the fee (`reverse_entry`), not by a credit, so the owner's draft was adjusted.
  dun: {
    en: 'Raises each overdue invoice in the run one reminder level and books any fee. A reminder that went out stays out; a wrong fee is corrected with a correcting entry.',
    'de-CH': 'Hebt jede überfällige Rechnung im Lauf um eine Mahnstufe an und bucht allfällige Gebühren. Eine versandte Mahnung bleibt versandt; eine falsche Gebühr korrigierst du mit einer Korrekturbuchung.',
    reversibility: 'correctable',
  },
  pay: {
    en: 'Records the payment and marks what it settles as paid. If it is wrong, you reverse the payment, which reopens them; both stay visible.',
    'de-CH': 'Erfasst die Zahlung und markiert, was sie begleicht, als bezahlt. Ist sie falsch, stornierst du die Zahlung, das öffnet die Posten wieder; beides bleibt sichtbar.',
    reversibility: 'correctable',
  },
  'vat-file': {
    en: 'Records that you filed this MWST period with the ESTV and seals its months for good. TILL sends nothing; later corrections go to the ESTV as a correction return.',
    'de-CH': 'Hält fest, dass du diese MWST-Periode bei der ESTV eingereicht hast, und versiegelt ihre Monate endgültig. TILL sendet nichts; spätere Korrekturen gehen als Korrekturabrechnung an die ESTV.',
    reversibility: 'final',
  },
  customize: {
    en: 'Changes how this workspace is set up for everyone in it. You can change it back, but the earlier setting is not kept.',
    'de-CH': 'Ändert, wie dieser Arbeitsbereich für alle eingerichtet ist. Du kannst es zurückändern, aber die frühere Einstellung wird nicht aufbewahrt.',
    reversibility: 'reversible',
  },
  'plugin-install': {
    en: 'Installs third-party code that runs with the rights you grant. You can disable or uninstall it; what it already did stays done.',
    'de-CH': 'Installiert Code von Dritten, der mit den Rechten läuft, die du gewährst. Du kannst ihn deaktivieren oder deinstallieren; was er schon getan hat, bleibt bestehen.',
    reversibility: 'reversible',
  },
  // Verified against A03 (`unlockPeriod`): an ordinary hard lock CAN be lifted by a holder of
  // `unlock_period`; only the filing and year-close seals refuse. The owner's draft ("a hard seal stays
  // closed") read as if every hard lock were permanent, so it names the two seals instead.
  'close-period': {
    en: 'Closes the period to further bookings. A soft close or a plain hard lock can be lifted with the right; a filed MWST period or a closed year stays sealed.',
    'de-CH': 'Sperrt die Periode für weitere Buchungen. Eine weiche oder eine gewöhnliche harte Sperre hebt auf, wer das Recht hat; eine eingereichte MWST-Periode oder ein abgeschlossenes Jahr bleibt versiegelt.',
    reversibility: 'reversible',
  },
  'go-live': {
    en: 'Moves migrated data into your real books. Undoing a step books correcting entries that stay on record; the switch to live books itself is final.',
    'de-CH': 'Überträgt die migrierten Daten in deine echte Buchhaltung. Einen Schritt zurückzunehmen erzeugt Korrekturbuchungen, die erhalten bleiben; der Wechsel auf die echten Bücher selbst ist endgültig.',
    reversibility: 'final',
  },
  // D156.3/.4: the fallback for a verb that deletes for good. Every erase verb carries its own entry
  // below; this says the one thing they share, with no way back implied.
  erase: {
    en: 'Deletes this for good. TILL keeps no copy to bring it back; keep your own if you may need it.',
    'de-CH': 'Löscht das endgültig. TILL behält keine Kopie, um es zurückzuholen; bewahre selbst eine auf, wenn du sie brauchen könntest.',
    reversibility: 'final',
  },
  // D156.3: consent for data leaving this machine or for outside access. The switch can be turned
  // back (`reversible`); what was already shared cannot, and the second sentence says so.
  share: {
    en: 'Lets data leave this machine or gives someone outside access to it. You can stop it at any time; what was already shared stays with whoever received it.',
    'de-CH': 'Lässt Daten diesen Rechner verlassen oder gibt jemandem ausserhalb Zugang. Du kannst das jederzeit beenden; was schon geteilt wurde, bleibt beim Empfänger.',
    reversibility: 'reversible',
  },
  // D161: stock moved or valued with no journal entry. Every stock verb carries its own entry below;
  // this says what they share (append-only movements, corrected by an opposite one).
  stock: {
    en: 'Changes your stock: the movement is recorded with its date, and nothing is booked to the ledger. A wrong movement is corrected with an opposite one; both stay on record.',
    'de-CH': 'Ändert deinen Lagerbestand: die Bewegung wird mit ihrem Datum erfasst, in die Buchhaltung wird nichts gebucht. Eine falsche Bewegung korrigierst du mit einer Gegenbewegung; beide bleiben erhalten.',
    reversibility: 'correctable',
  },
};

/**
 * The verbs with something more specific to say than their family. A dial-governed verb absent here
 * (`post_entry`, `issue_invoice`, `send_invoice`, `record_payment`, `vat_mark_filed`, `install_plugin`)
 * reads its family sentence, which already says exactly what it does.
 */
export const CONSEQUENCE_FOR_VERB: Readonly<Record<string, Consequence>> = {
  // --- post: the ledger ------------------------------------------------------------------------
  reverse_entry: {
    en: 'Books a correcting entry that mirrors a posted one; the original stays visible beside it. If the correction was wrong, you correct it the same way.',
    'de-CH': 'Bucht eine Korrekturbuchung, die eine gebuchte Buchung spiegelt; das Original bleibt daneben sichtbar. War die Korrektur falsch, korrigierst du sie auf dieselbe Weise.',
    reversibility: 'correctable',
  },
  create_entry_for_txn: {
    en: 'Books the bank line to the account you choose. If it is wrong, you reopen the line, which books a correcting entry; both stay visible.',
    'de-CH': 'Bucht die Bankzeile auf das gewählte Konto. Ist das falsch, öffnest du die Zeile wieder; das erzeugt eine Korrekturbuchung, und das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  wage_journal_post: {
    en: "Books the month's wage journal from your payroll as one entry. If it is wrong, you correct it with a correcting entry; both stay visible.",
    'de-CH': 'Bucht das Lohnjournal des Monats aus deiner Lohnbuchhaltung als eine Buchung. Ist es falsch, korrigierst du es mit einer Korrekturbuchung; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  post_vendor_bill: {
    en: 'Books the vendor bill in your accounts. If it is wrong, you void the bill, which books a correcting entry; both stay on record.',
    'de-CH': 'Bucht die Lieferantenrechnung in deine Buchhaltung. Ist sie falsch, stornierst du sie mit einer Korrekturbuchung; beides bleibt erhalten.',
    reversibility: 'correctable',
  },
  record_expense: {
    en: 'Records the vendor bill and books it in one step. If it is wrong, you void the bill, which books a correcting entry; both stay on record.',
    'de-CH': 'Erfasst die Lieferantenrechnung und bucht sie in einem Schritt. Ist sie falsch, stornierst du sie mit einer Korrekturbuchung; beides bleibt erhalten.',
    reversibility: 'correctable',
  },
  void_vendor_bill: {
    en: 'Voids the vendor bill and books its correcting entry; payments against it must be reversed first. The bill and its correction stay on record; if the void was wrong, you record and post the bill again.',
    'de-CH': 'Storniert die Lieferantenrechnung mit einer Korrekturbuchung; Zahlungen darauf stornierst du vorher. Rechnung und Korrektur bleiben erhalten; war das falsch, erfasst und buchst du die Rechnung neu.',
    reversibility: 'correctable',
  },
  post_fx_revaluation: {
    en: 'Books the period-end currency gain or loss, with its automatic reversal on the first day of the next period. If it is wrong, you revert the run with correcting entries; the originals stay visible.',
    'de-CH': 'Bucht den Kursgewinn oder -verlust am Periodenende, mit automatischer Rückbuchung am ersten Tag der nächsten Periode. Ist das falsch, nimmst du den Lauf mit Korrekturbuchungen zurück; die Originale bleiben sichtbar.',
    reversibility: 'correctable',
  },
  fx_revaluation_reverse: {
    en: "Reverts the period-end currency revaluation with mirror entries, so every account nets to zero. The original entries stay visible beside them; this revert can't be reverted again.",
    'de-CH': 'Nimmt die Fremdwährungsbewertung am Periodenende mit gespiegelten Korrekturbuchungen zurück, sodass jedes Konto auf null steht. Die Originale bleiben sichtbar; das lässt sich nicht nochmals zurücknehmen.',
    reversibility: 'final',
  },
  accrual_post: {
    en: 'Books the accrual and its automatic reversal in the next period as one pair. If it is wrong, you revert it with a mirror pair; all four entries stay visible.',
    'de-CH': 'Bucht die Abgrenzung und ihre automatische Rückbuchung in der nächsten Periode als Paar. Ist sie falsch, nimmst du sie mit einem gespiegelten Paar Korrekturbuchungen zurück; alle vier bleiben sichtbar.',
    reversibility: 'correctable',
  },
  accrual_reverse: {
    en: 'Books the mirror pair against a posted accrual, so every account nets to zero; the original pair stays visible. If the reversal was wrong, you create and post the accrual again.',
    'de-CH': 'Bucht ein gespiegeltes Paar Korrekturbuchungen gegen die Abgrenzung, sodass jedes Konto auf null steht; das Original bleibt sichtbar. War das falsch, erfasst und buchst du die Abgrenzung neu.',
    reversibility: 'correctable',
  },
  provision_post: {
    en: 'Books the provision as one entry; it is not released automatically. You release it later, or correct it with a correcting entry; both stay visible.',
    'de-CH': 'Bucht die Rückstellung als eine Buchung; sie wird nicht automatisch aufgelöst. Du löst sie später auf oder korrigierst sie mit einer Korrekturbuchung; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  provision_release: {
    en: 'Books the release of part or all of the provision to the target account. If it is wrong, you undo the release with a correcting entry; both stay visible.',
    'de-CH': 'Bucht die Auflösung eines Teils oder der ganzen Rückstellung auf das Zielkonto. Ist sie falsch, nimmst du die Auflösung mit einer Korrekturbuchung zurück; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  provision_reverse: {
    en: "Corrects the provision's original booking with a correcting entry; any releases have to be undone first. The original stays visible; if this was wrong, you create and post the provision again.",
    'de-CH': 'Korrigiert die Bildung der Rückstellung mit einer Korrekturbuchung; Auflösungen nimmst du vorher zurück. Das Original bleibt sichtbar; war das falsch, erfasst und buchst du die Rückstellung neu.',
    reversibility: 'correctable',
  },
  provision_release_reverse: {
    en: 'Undoes one release of the provision with a correcting entry and restores its open balance. The release stays visible; to release again, you book a new release.',
    'de-CH': 'Nimmt eine Auflösung der Rückstellung mit einer Korrekturbuchung zurück und stellt den offenen Betrag wieder her. Die Auflösung bleibt sichtbar; aufgelöst wird mit einer neuen Auflösung.',
    reversibility: 'correctable',
  },
  vat_settlement_post: {
    en: "Moves the filed period's MWST balances from 2200, 1170 and 1171 to 2201; the filed return does not change. If it is wrong, you reverse the settlement and book it again.",
    'de-CH': 'Überträgt die MWST-Salden der eingereichten Periode von 2200, 1170 und 1171 auf 2201; die eingereichte Abrechnung ändert sich nicht. Ist das falsch, korrigierst du die Saldierung und buchst sie neu.',
    reversibility: 'correctable',
  },
  vat_settlement_reverse: {
    en: 'Reverses the MWST settlement with a correcting entry dated the period end; the settlement stays on record as reversed. You can then book a new settlement for the period.',
    'de-CH': 'Korrigiert die MWST-Saldierung mit einer Korrekturbuchung per Periodenende; die Saldierung bleibt als korrigiert erhalten. Danach kannst du für die Periode eine neue Saldierung buchen.',
    reversibility: 'correctable',
  },
  // The row-backed sources with no undo verb (asset acquisition, capitalisation and disposal, expense
  // claims): a raw correcting entry reverses the BOOKING but leaves the register row, which is what
  // these sentences say (`reverseEntry.ts`, the design call recorded there).
  expense_claim_approve: {
    en: 'Approves the expense claim and books what you owe the employee. A correcting entry can reverse the booking, but the claim stays approved.',
    'de-CH': 'Genehmigt die Spesenabrechnung und bucht, was du der mitarbeitenden Person schuldest. Eine Korrekturbuchung kann die Buchung korrigieren, die Abrechnung bleibt aber genehmigt.',
    reversibility: 'correctable',
  },
  asset_acquire: {
    en: "Books the asset's purchase and adds it to the register, which locks its cost figures. A correcting entry can reverse the booking, but the register keeps the purchase.",
    'de-CH': 'Bucht die Anschaffung der Anlage und nimmt sie ins Anlagenverzeichnis auf; ihre Kostenwerte sind danach gesperrt. Eine Korrekturbuchung kann die Buchung korrigieren, das Verzeichnis behält sie aber.',
    reversibility: 'correctable',
  },
  asset_add_capitalisation: {
    en: 'Books additional cost onto the asset and raises its book value. A correcting entry can reverse the booking, but the register keeps the added cost.',
    'de-CH': 'Bucht zusätzliche Kosten auf die Anlage und erhöht ihren Buchwert. Eine Korrekturbuchung kann die Buchung korrigieren, das Anlagenverzeichnis behält die Kosten aber.',
    reversibility: 'correctable',
  },
  asset_opening_balance: {
    en: "Books the asset's carried-over cost and depreciation into the opening position and locks its cost figures. A correcting entry can reverse the booking, but the register keeps the figures.",
    'de-CH': 'Bucht die übernommenen Kosten und Abschreibungen der Anlage in die Eröffnungsbilanz und sperrt ihre Kostenwerte. Eine Korrekturbuchung kann die Buchung korrigieren, das Verzeichnis behält die Werte aber.',
    reversibility: 'correctable',
  },
  asset_dispose: {
    en: "Books the asset's sale or write-off with its gain or loss and takes it out of the register. A correcting entry reverses the booking; to have the asset in the register again, you record it anew.",
    'de-CH': 'Bucht Verkauf oder Ausbuchung der Anlage mit Gewinn oder Verlust und nimmt sie aus dem Verzeichnis. Eine Korrekturbuchung korrigiert die Buchung; ins Verzeichnis kommt die Anlage nur neu erfasst zurück.',
    reversibility: 'correctable',
  },
  asset_depreciation_run_post: {
    en: 'Books the depreciation for every asset in the run; posting it twice never counts twice. If it is wrong, you reverse the run with a correcting entry; both stay visible.',
    'de-CH': 'Bucht die Abschreibung für jede Anlage im Lauf; doppelt gebucht zählt nie doppelt. Ist sie falsch, nimmst du den Lauf mit einer Korrekturbuchung zurück; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  asset_depreciation_run_reverse: {
    en: "Reverses a posted depreciation run with a correcting entry and restores each asset's book value. The run stays visible as reversed; if that was wrong, you create and post the run again.",
    'de-CH': 'Korrigiert einen gebuchten Abschreibungslauf mit einer Korrekturbuchung und stellt den Buchwert jeder Anlage wieder her. Der Lauf bleibt sichtbar; war das falsch, erstellst und buchst du ihn neu.',
    reversibility: 'correctable',
  },
  inventory_valuation_post: {
    en: 'Books the change in inventory value and updates the inventory figure on the balance sheet. If it is wrong, you reverse the run with a correcting entry and post a fresh one.',
    'de-CH': 'Bucht die Veränderung des Lagerwerts und aktualisiert den Lagerbestand in der Bilanz. Ist sie falsch, nimmst du den Lauf mit einer Korrekturbuchung zurück und buchst einen neuen.',
    reversibility: 'correctable',
  },
  inventory_valuation_reverse: {
    en: 'Reverses a posted valuation run with a correcting entry and restores the baseline the next run measures against. The original run stays visible; a fresh run books the right figure.',
    'de-CH': 'Korrigiert einen gebuchten Bewertungslauf mit einer Korrekturbuchung und stellt die Basis wieder her, an der der nächste Lauf misst. Der Lauf bleibt sichtbar; den richtigen Wert bucht ein neuer Lauf.',
    reversibility: 'correctable',
  },
  inventory_valuation_opening: {
    en: 'Books the opening inventory value, the baseline every later valuation run measures against. If it is wrong, you reverse the run with a correcting entry; both stay visible.',
    'de-CH': 'Bucht den Eröffnungswert des Lagers, die Basis, an der jeder spätere Bewertungslauf misst. Ist er falsch, nimmst du den Lauf mit einer Korrekturbuchung zurück; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  landed_cost_allocate_confirm: {
    en: 'Spreads the extra purchase costs across the received goods and books them as one entry. If it is wrong, you reverse the allocation with a correcting entry; the original stays visible.',
    'de-CH': 'Verteilt die Bezugskosten auf die erhaltene Ware und bucht sie als eine Buchung. Ist das falsch, nimmst du die Verteilung mit einer Korrekturbuchung zurück; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  landed_cost_reverse: {
    en: 'Reverses a confirmed landed-cost allocation with a correcting entry; nothing in the original is edited. The voucher stays on record as reversed; to allocate again, you start a new voucher.',
    'de-CH': 'Nimmt eine bestätigte Bezugskostenverteilung mit einer Korrekturbuchung zurück; am Original wird nichts geändert. Der Beleg bleibt als korrigiert erhalten; neu verteilst du mit einem neuen Beleg.',
    reversibility: 'correctable',
  },
  set_bank_opening_balance: {
    en: "Books the bank account's opening balance against 9100 Eröffnungsbilanz, once. A correction is a correcting entry, never a second opening; both stay visible.",
    'de-CH': 'Bucht den Eröffnungssaldo des Bankkontos gegen 9100 Eröffnungsbilanz, einmal. Korrigiert wird mit einer Korrekturbuchung, nie mit einer zweiten Eröffnung; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  import_opening_balances: {
    en: 'Books the imported opening position as one balanced entry. If it is wrong, you correct it with a correcting entry; both stay visible.',
    'de-CH': 'Bucht die importierte Eröffnungsbilanz als eine ausgeglichene Buchung. Ist sie falsch, korrigierst du sie mit einer Korrekturbuchung; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  // D158. Verified against `setOpeningBalances`: one opening entry per fiscal year
  // (`opening_balance_already_set`), and the correction its own description names: reverse the entry,
  // then a fresh call under a new key, which the verb accepts once the reversal has unwound the old one.
  set_opening_balances: {
    en: 'Books your opening position as one balanced opening entry for the year. If it is wrong, you correct it with a correcting entry and enter the position again; both stay visible.',
    'de-CH': 'Bucht deine Eröffnungsbilanz als eine ausgeglichene Eröffnungsbuchung für das Jahr. Ist sie falsch, korrigierst du sie mit einer Korrekturbuchung und erfasst sie neu; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  // D158, the two stocktake commits (D01 `stocktakeCommit`, J04 `inventoryStocktakeCommit`). Verified:
  // each difference is minted as a stock movement dated the freeze date, the session turns `committed`
  // and nothing sets it back, and neither reaches `postEntry` (the valuation run books later). The
  // stock is corrected by a new adjustment (`stock_move` with reason adjust, `inventory_adjust`).
  stock_stocktake_commit: {
    en: "Books each counted difference as a stock adjustment on the count date and seals the count for good as your inventory record; nothing goes to the ledger. It can't be reopened; later stock errors get a new adjustment.",
    'de-CH': 'Erfasst jede gezählte Differenz als Lagerkorrektur per Zähldatum und schliesst die Zählung endgültig als Bestandesnachweis ab, ohne Buchung. Wieder öffnen geht nicht; spätere Fehler erhalten eine neue Korrektur.',
    reversibility: 'final',
  },
  // D158 critic F2: J04 commits cycle counts too, and only a FULL session is the Bestandesnachweis
  // (`bestandesnachweis: null` otherwise), so the sentence names it as the full stocktake's case.
  inventory_stocktake_commit: {
    en: "Books each counted difference as a stock adjustment on the count date and seals the count for good (a full stocktake is your inventory record). It can't be reopened; later stock errors get a new adjustment.",
    'de-CH': 'Erfasst jede gezählte Differenz als Lagerkorrektur per Zähldatum und schliesst die Zählung endgültig ab (eine Vollinventur ist dein Bestandesnachweis). Wieder öffnen geht nicht; Fehler erhalten eine neue Korrektur.',
    reversibility: 'final',
  },

  // --- issue: documents ------------------------------------------------------------------------
  issue_credit_note: {
    en: "Issues the credit note with its number and books it against the invoice; from then on it can't be edited. If it is wrong, you cancel it, which books a correcting entry.",
    'de-CH': 'Stellt die Gutschrift mit ihrer Nummer aus und bucht sie gegen die Rechnung; danach lässt sie sich nicht mehr ändern. Ist sie falsch, stornierst du sie mit einer Korrekturbuchung.',
    reversibility: 'correctable',
  },
  transition_document: {
    en: 'Moves the document to its next status: issuing numbers it and books an invoice or credit note, accepting makes a quote binding. A wrong issued invoice is cancelled with a correcting entry or corrected by a credit note.',
    'de-CH': 'Setzt das Dokument auf den nächsten Status: Ausstellen nummeriert und bucht Rechnung oder Gutschrift, Annehmen macht eine Offerte verbindlich. Eine falsche Rechnung stornierst du mit Korrekturbuchung oder per Gutschrift.',
    reversibility: 'correctable',
  },
  create_recurring_schedule: {
    en: 'Sets up a recurring invoice. With auto-issue on, every due date issues and books an invoice without asking again; you can pause or end it, and a wrong invoice gets a credit note.',
    'de-CH': 'Richtet eine Serienrechnung ein. Mit automatischem Ausstellen wird an jedem Termin ohne Rückfrage ausgestellt und gebucht; du kannst sie pausieren oder beenden, eine falsche Rechnung erhält eine Gutschrift.',
    reversibility: 'correctable',
  },
  // D158. Verified against `issueDeliveryNote`: one stock issue movement per line, `delivered_qty`
  // raised, `issued` is terminal (`DN_TRANSITIONS`), no verb lowers `delivered_qty`, and the order can
  // no longer be cancelled (`has_deliveries`). Goods that come back are a D01 `return` movement.
  delivery_note_issue: {
    en: "Ships the delivery note: the goods leave stock and the order counts them as delivered. An issued note can't be cancelled or edited; goods that come back are booked in with a stock return.",
    'de-CH': 'Liefert den Lieferschein aus: die Ware verlässt das Lager, und der Auftrag zählt sie als geliefert. Ein ausgestellter Lieferschein lässt sich weder stornieren noch ändern; Rückware erfasst du als Rücknahme ins Lager.',
    reversibility: 'final',
  },
  update_recurring_schedule: {
    en: 'Changes what a recurring invoice bills, to whom or when, from its next occurrence on; with auto-issue on, without asking again. Invoices already made stay as they are; you can change it again.',
    'de-CH': 'Ändert, was eine Serienrechnung wem und wann verrechnet, ab dem nächsten Termin; mit automatischem Ausstellen ohne Rückfrage. Erstellte Rechnungen bleiben, wie sie sind; ändern geht wieder.',
    reversibility: 'correctable',
  },

  // --- dun: the reminder run -------------------------------------------------------------------
  propose_dunning_run: {
    en: 'Drafts a reminder run over the invoices overdue on the given date. Nothing is booked or sent until you issue the run; a wrong draft is replaced by proposing again.',
    'de-CH': 'Entwirft einen Mahnlauf über die Rechnungen, die am gewählten Datum überfällig sind. Gebucht oder versendet wird erst beim Ausstellen; einen falschen Entwurf ersetzt ein neuer Vorschlag.',
    reversibility: 'correctable',
  },
  // D161.3. Verified against `discardDunningRun`: only a `proposed` run is accepted, its rows are
  // removed (nothing was booked, rendered or sent), one audit row records the discard, and the day's
  // `dunning_run_per_day` slot is free for a new `propose_dunning_run`. No verb brings the run back.
  discard_dunning_run: {
    en: 'Discards the proposed reminder run; nothing was booked or sent. The run cannot be brought back, but you can propose a new run for the same day.',
    'de-CH': 'Verwirft den vorgeschlagenen Mahnlauf; gebucht oder versendet wurde nichts. Der Lauf lässt sich nicht zurückholen, du kannst aber für denselben Tag einen neuen vorschlagen.',
    reversibility: 'final',
  },
  issue_dunning_run: {
    en: 'Raises each invoice in the run one reminder level for good and books any reminder fee. The level is never lowered again; a wrong fee is corrected with a correcting entry.',
    'de-CH': 'Hebt jede Rechnung im Lauf endgültig um eine Mahnstufe an und bucht allfällige Mahngebühren. Die Stufe sinkt nie wieder; eine falsche Gebühr korrigierst du mit einer Korrekturbuchung.',
    reversibility: 'final',
  },
  send_dunning_run: {
    en: "Emails the reminder letters, one per customer, skipping any letter whose invoices changed since the run was issued. A sent letter can't be called back; a correction goes out separately.",
    'de-CH': 'Versendet die Mahnbriefe per E-Mail, einen pro Kunde, ausser Briefe, deren Rechnungen sich seit dem Ausstellen geändert haben. Ein versandter Brief lässt sich nicht zurückholen.',
    reversibility: 'final',
  },

  // --- pay: settlement -------------------------------------------------------------------------
  allocate_payment: {
    en: 'Applies a payment already on the books to open items and marks them paid; nothing new is booked. A wrong allocation is corrected by reversing the whole payment and recording it again.',
    'de-CH': 'Ordnet eine bereits gebuchte Zahlung offenen Posten zu und markiert sie als bezahlt; neu gebucht wird nichts. Bei falscher Zuordnung stornierst du die ganze Zahlung und erfasst sie neu.',
    reversibility: 'correctable',
  },
  reverse_payment: {
    en: 'Reverses the payment with a correcting entry and reopens everything it settled. The original stays visible; if the payment was right after all, you record it again.',
    'de-CH': 'Storniert die Zahlung mit einer Korrekturbuchung und öffnet alles wieder, was sie beglichen hat. Das Original bleibt sichtbar; war die Zahlung doch richtig, erfasst du sie neu.',
    reversibility: 'correctable',
  },
  mark_batch_paid: {
    en: 'Confirms the bank paid the batch: records one payment per bill and marks every bill in it as paid. If the bank did not pay, you reverse those payments, which reopens the bills.',
    'de-CH': 'Bestätigt, dass die Bank den Zahlungslauf ausgeführt hat, erfasst je Rechnung eine Zahlung und markiert sie als bezahlt. Hat die Bank nicht gezahlt, stornierst du diese Zahlungen.',
    reversibility: 'correctable',
  },
  payment_batch_transmit: {
    en: "Submits the payment batch to your bank over the connected channel; TILL can't call it back. It marks nothing as paid: that comes from booking the bank debit or confirming the batch as paid.",
    'de-CH': 'Übermittelt den Zahlungslauf über den verbundenen Kanal an deine Bank; TILL kann ihn nicht zurückholen. Als bezahlt markiert er nichts: das geschieht beim Buchen der Belastung oder mit deiner Bestätigung.',
    reversibility: 'final',
  },
  apply_qr_match: {
    en: 'Settles the invoice from the received payment and books it. If the match is wrong, you undo it, which reverses the payment with a correcting entry; both stay visible.',
    'de-CH': 'Begleicht die Rechnung mit der eingegangenen Zahlung und bucht sie. Ist die Zuordnung falsch, hebst du sie auf; das storniert die Zahlung mit einer Korrekturbuchung, beides bleibt sichtbar.',
    reversibility: 'correctable',
  },
  override_qr_match: {
    en: 'Points the received payment at another invoice or takes it out of the match; an applied match is first reversed with a correcting entry. You can change it again; every booking stays visible.',
    'de-CH': 'Ordnet die eingegangene Zahlung einer anderen Rechnung zu oder löst die Zuordnung; eine angewendete wird zuerst mit einer Korrekturbuchung storniert. Du kannst das wieder ändern; alles bleibt sichtbar.',
    reversibility: 'correctable',
  },
  confirm_match: {
    en: 'Settles the bank debit against its vendor bills, or matches it to an entry already in the books. If it is wrong, you reopen the bank line and reverse what it booked.',
    'de-CH': 'Begleicht die Belastung mit den Lieferantenrechnungen oder ordnet sie einer bestehenden Buchung zu. Ist das falsch, öffnest du die Bankzeile wieder und korrigierst, was sie gebucht hat.',
    reversibility: 'correctable',
  },
  expense_claim_reimburse: {
    en: 'Records the payment to the employee for the approved claim and prepares the payment file; a claim is never paid twice. Reversing the payment reopens the claim.',
    'de-CH': 'Erfasst die Auszahlung der genehmigten Spesen und bereitet die Zahlungsdatei vor; doppelt bezahlt wird nie. Stornierst du die Zahlung, ist die Abrechnung wieder offen.',
    reversibility: 'correctable',
  },
  confirm_statement_gap: {
    en: 'Records that the missing bank statements between two statements hold no money, so the gap stops waiting for you. You can withdraw this, and a statement found later still imports.',
    'de-CH': 'Hält fest, dass die fehlenden Kontoauszüge zwischen zwei Auszügen kein Geld enthalten; die Lücke wartet nicht mehr auf dich. Du kannst das widerrufen, ein später gefundener Auszug wird trotzdem importiert.',
    reversibility: 'reversible',
  },
  revoke_statement_gap_confirmation: {
    en: 'Withdraws the confirmation that a statement gap holds nothing, so the gap waits for a person again. The confirmation stays on record beside the withdrawal.',
    'de-CH': 'Widerruft die Bestätigung, dass eine Lücke zwischen Kontoauszügen nichts enthält; die Lücke wartet wieder auf eine Person. Die Bestätigung bleibt neben dem Widerruf erhalten.',
    reversibility: 'reversible',
  },
  // A39, the bank inbox. A run booked through `payment_batch` keeps its payments on reopen (D-A39.3).
  book_bank_line: {
    en: 'Books the bank line: posts its entry, or settles the invoice, bill or payment run it paid. If it is wrong, you reopen the line and reverse what it booked; the first booking stays visible.',
    'de-CH': 'Bucht die Bankzeile als Buchung oder als Zahlung der Rechnung oder des Zahlungslaufs, den sie begleicht. Ist das falsch, öffnest du die Zeile wieder und korrigierst; das Original bleibt sichtbar.',
    reversibility: 'correctable',
  },
  ignore_bank_line: {
    en: 'Takes the bank line out of the inbox with your reason and books nothing. Its money still has to reach the books elsewhere; you can reopen the line at any time.',
    'de-CH': 'Nimmt die Bankzeile mit deiner Begründung aus dem Eingang und bucht nichts. Das Geld darauf muss anderswo in die Bücher; du kannst die Zeile jederzeit wieder öffnen.',
    reversibility: 'reversible',
  },
  reopen_bank_line: {
    en: 'Opens the bank line again: a booking or payment it made is reversed with a correcting entry, but a payment run keeps its payments. The old decision stays on record; you can book the line afresh.',
    'de-CH': 'Öffnet die Bankzeile wieder: eine Buchung oder Zahlung daraus wird mit einer Korrekturbuchung korrigiert, ein Zahlungslauf behält seine Zahlungen. Der alte Entscheid bleibt erhalten.',
    reversibility: 'correctable',
  },
  // The payee master data. `set_creditor_profile` KEEPS its engine scope until the D146 freeze of the
  // QR data at issue lands: the QR-bill is resolved LIVE from `workspace.creditor_iban`, so a changed
  // IBAN also moves the QR-bill of every invoice already issued and still open (critic
  // phase0-installable r2, R2-1). NARROW THIS ENTRY IN THE SAME COMMIT THAT ADDS THE D146 FREEZE.
  set_creditor_profile: {
    en: 'Changes the account every QR-bill is paid into, including the QR-bills of invoices already open when they are downloaded, sent again or dunned. A customer who already paid is not affected.',
    'de-CH': 'Ändert das Konto, auf das jede QR-Rechnung bezahlt wird, auch für die QR-Rechnungen offener Rechnungen, wenn du sie erneut herunterlädst, sendest oder mahnst. Wer schon bezahlt hat, ist nicht betroffen.',
    reversibility: 'reversible',
  },
  set_creditor_bank_profile: {
    en: "Changes the IBAN this vendor is paid at, for every later payment run. Check it against the vendor's invoice.",
    'de-CH': 'Ändert die IBAN, auf die dieser Lieferant bezahlt wird, für jeden späteren Zahlungslauf. Prüfe sie an seiner Rechnung.',
    reversibility: 'reversible',
  },

  // --- customize: the workspace's structure ----------------------------------------------------
  define_field: {
    en: 'Adds or changes a custom field on every record of the chosen kind, for everyone in the workspace. You can archive it later; values already stored are kept.',
    'de-CH': 'Legt ein eigenes Feld auf jedem Datensatz der gewählten Art an oder ändert es, für alle im Arbeitsbereich. Du kannst es später archivieren; gespeicherte Werte bleiben erhalten.',
    reversibility: 'correctable',
  },
  invite_member: {
    en: 'Gives a person or an agent access with the chosen role. Whoever redeems the invitation sees the books until you revoke the access; what they saw stays seen.',
    'de-CH': 'Gibt einer Person oder einem Agenten Zugang mit der gewählten Rolle. Wer die Einladung einlöst, sieht die Bücher, bis du den Zugang entziehst; Gesehenes bleibt gesehen.',
    reversibility: 'correctable',
  },
  set_role: {
    en: 'Changes what this member may see and do, from their next step on. You can change it again at any time.',
    'de-CH': 'Ändert, was dieses Mitglied sehen und tun darf, ab seinem nächsten Schritt. Du kannst es jederzeit wieder ändern.',
    reversibility: 'reversible',
  },
  revoke_member: {
    en: "Removes this member's access from their next step on. What they did stays on record; you can invite them again.",
    'de-CH': 'Entzieht diesem Mitglied den Zugang ab seinem nächsten Schritt. Was es getan hat, bleibt erhalten; du kannst es neu einladen.',
    reversibility: 'correctable',
  },
  define_role: {
    en: 'Changes what this role may do, for everyone who holds it. The earlier set of rights is not kept.',
    'de-CH': 'Ändert, was diese Rolle darf, für alle, die sie haben. Die frühere Zusammenstellung der Rechte wird nicht aufbewahrt.',
    reversibility: 'reversible',
  },
  set_bank_sync_schedule: {
    en: "Sets when TILL fetches your bank statements each day, or turns that off. The fetch runs in the name of whoever set it, or the owner's once that person loses the right.",
    'de-CH': 'Legt fest, wann TILL deine Kontoauszüge täglich abruft, oder schaltet das aus. Der Abruf läuft im Namen der Person, die ihn eingestellt hat, oder des Inhabers, sobald sie das Recht verliert.',
    reversibility: 'reversible',
  },
  enable_automation_rule: {
    en: "Lets the rule fire again: every matching event then runs its action in its author's name, unattended. You can disable it at any time; what it already did stays done.",
    'de-CH': 'Lässt die Regel wieder auslösen: jedes passende Ereignis führt ihre Aktion unbeaufsichtigt im Namen ihrer Urheberin oder ihres Urhebers aus. Du kannst sie jederzeit deaktivieren.',
    reversibility: 'reversible',
  },
  create_automation_rule: {
    en: "Creates the automation rule; once enabled, it runs its action in its author's name on every matching event, unattended. You can disable or archive it; what it already did stays done.",
    'de-CH': 'Legt die Automatisierungsregel an; aktiv führt sie ihre Aktion bei jedem passenden Ereignis unbeaufsichtigt im Namen ihres Urhebers aus. Du kannst sie deaktivieren oder archivieren.',
    reversibility: 'reversible',
  },
  update_automation_rule: {
    en: 'Changes what the rule reacts to or does, from the next event on; an enabled rule runs the change unattended. You can change it again, but the earlier version is not kept.',
    'de-CH': 'Ändert, worauf die Regel reagiert oder was sie tut, ab dem nächsten Ereignis; eine aktive Regel führt das unbeaufsichtigt aus. Du kannst sie wieder ändern, die frühere Fassung wird nicht aufbewahrt.',
    reversibility: 'reversible',
  },

  // --- plugin-install: third-party code (D160.5) ------------------------------------------------
  // D160.1 (d): starting third-party code waits for a person. `install_plugin` reads the family
  // sentence; these two START code that is already installed, so each says so. Verified against G02:
  // `enablePlugin` re-registers the stored capabilities and the host starts the sandbox, and
  // `refreshPluginCompat` does the same when an `incompatible` plugin's range is satisfied again.
  // `disable_plugin` stops either one, and nothing the plugin did is undone by it: the D161 map classes
  // `refresh_plugin_compat` correctable for that reason (its entry sits with the D161 verbs below).
  // `uninstall_plugin` (D161.1): `uninstallPlugin` sweeps the registrations, writes an audit row and
  // deletes the manifest row (with its grants); it touches no business data, and the only way back is
  // a fresh `install_plugin`, itself governed.
  enable_plugin: {
    en: 'Starts this plugin\'s third-party code again with the rights you granted, and its tools come back. You can disable it again at any time; what it does while it runs stays done.',
    'de-CH': 'Startet den Code von Dritten dieses Plugins wieder mit den Rechten, die du gewährt hast, und seine Werkzeuge sind zurück. Du kannst es jederzeit wieder deaktivieren; was es in der Zwischenzeit tut, bleibt bestehen.',
    reversibility: 'reversible',
  },
  uninstall_plugin: {
    en: 'Stops this plugin\'s third-party code and removes it for good with the rights you granted; your business data stays. To use it again, it has to be installed anew, which by default waits for your OK.',
    'de-CH': 'Stoppt den Code von Dritten dieses Plugins und entfernt es endgültig mit den gewährten Rechten; deine Geschäftsdaten bleiben. Willst du es wieder nutzen, installierst du es neu, und das wartet standardmässig auf dein OK.',
    reversibility: 'final',
  },

  // --- close-period: the seals -----------------------------------------------------------------
  close_year: {
    en: 'Closes the fiscal year for good: the profit or loss moves into equity and nothing more can be booked into that year. There is no reopening; a mistake found later is corrected in the following year.',
    'de-CH': 'Schliesst das Geschäftsjahr endgültig ab: Gewinn oder Verlust gehen ins Eigenkapital, und in dieses Jahr wird nichts mehr gebucht. Es lässt sich nicht wieder öffnen; spätere Fehler korrigierst du im Folgejahr.',
    reversibility: 'final',
  },
  lock_period: {
    en: 'Locks the period, so nothing more can be booked into it. A soft lock can be lifted at any time; a hard lock only by someone with the right to unlock.',
    'de-CH': 'Sperrt die Periode, sodass nichts mehr hineingebucht werden kann. Eine weiche Sperre lässt sich jederzeit aufheben, eine harte nur von jemandem mit dem Recht dazu.',
    reversibility: 'reversible',
  },
  close_month: {
    en: 'Closes the month, so nothing more can be booked into it. You can reopen it unless it has been hard-locked since.',
    'de-CH': 'Schliesst den Monat, sodass nichts mehr hineingebucht werden kann. Du kannst ihn wieder öffnen, solange er nicht hart gesperrt wurde.',
    reversibility: 'reversible',
  },
  reopen_month: {
    en: 'Reopens a closed month, so bookings into it are accepted again. You can close it again at any time.',
    'de-CH': 'Öffnet einen abgeschlossenen Monat wieder, sodass Buchungen darin wieder möglich sind. Du kannst ihn jederzeit wieder schliessen.',
    reversibility: 'reversible',
  },
  unlock_period: {
    en: 'Lifts the period lock, so bookings into it are accepted again; a filed MWST period or a closed year stays sealed. You can lock it again at any time.',
    'de-CH': 'Hebt die Sperre der Periode auf, sodass Buchungen wieder möglich sind; eine eingereichte MWST-Periode oder ein abgeschlossenes Jahr bleibt versiegelt. Du kannst sie jederzeit wieder sperren.',
    reversibility: 'reversible',
  },

  // D158. Verified against `timeLock` and the billing reads: `approved -> locked` has no way back
  // (`TIME_TRANSITIONS`), and B02 (`eligibleEntries`) and B04 bill only `approved` time, so locked
  // time is never billed. Approved time was already frozen against edits; billing is what locking ends.
  time_lock: {
    en: "Locks the period's approved time as the final working-time record. Locked time can't be billed and there is no unlock, so invoice billable time first.",
    'de-CH': 'Sperrt die freigegebene Zeit der Periode als endgültigen Arbeitszeitnachweis. Gesperrte Zeit lässt sich weder verrechnen noch entsperren; verrechne verrechenbare Zeit also vorher.',
    reversibility: 'final',
  },

  // --- go-live: the cutover --------------------------------------------------------------------
  go_productive: {
    en: 'Turns the trial workspace into your real books, in place. This switch is final; a mistake found later is corrected with a correcting entry.',
    'de-CH': 'Macht den Testmandanten an Ort und Stelle zu deiner echten Buchhaltung. Dieser Wechsel ist endgültig; einen später gefundenen Fehler korrigierst du mit einer Korrekturbuchung.',
    reversibility: 'final',
  },
  import_open_items: {
    en: 'Brings the open customer invoices and vendor bills from your old system into the live books, tied to the opening balance. The batch has no undo; you correct a wrong item on its own.',
    'de-CH': 'Übernimmt die offenen Debitoren- und Kreditorenrechnungen aus dem alten System, abgestimmt auf die Eröffnungsbilanz. Der Import lässt sich nicht zurücknehmen; einen falschen Posten korrigierst du einzeln.',
    reversibility: 'final',
  },
  migration_commit_step: {
    en: "Moves this step's migrated data into your live books. You can roll the step back later; that books correcting entries, and the commit stays on record.",
    'de-CH': 'Überträgt die migrierten Daten dieses Schritts in deine echten Bücher. Du kannst den Schritt später zurücknehmen; das erzeugt Korrekturbuchungen, und die Übernahme bleibt erhalten.',
    reversibility: 'correctable',
  },
  migration_rollback_step: {
    en: 'Reverses what this migration step put into your live books with correcting entries and archives its records. The reversals stay on record; after a new check, you can commit the step again.',
    'de-CH': 'Nimmt mit Korrekturbuchungen zurück, was dieser Migrationsschritt in die echten Bücher brachte, und archiviert seine Stammdaten. Nach einer neuen Prüfung kannst du den Schritt wieder übernehmen.',
    reversibility: 'correctable',
  },

  // --- go-live: the two "the cutover is finished" declarations (D156.3) --------------------------
  // Verified: `projectClose` and `closePlan` flip status to `closed`, and no verb sets it back.
  implementation_project_close: {
    en: 'Closes the implementation project as finished, once its closing tasks and sign-offs are done. A closed project cannot be reopened; its record stays.',
    'de-CH': 'Schliesst das Einführungsprojekt als erledigt ab, sobald die Abschlussaufgaben und Freigaben vorliegen. Ein abgeschlossenes Projekt lässt sich nicht wieder öffnen; seine Unterlagen bleiben.',
    reversibility: 'final',
  },
  migration_close_plan: {
    en: 'Marks the data migration as finished, once every step is done and no check has failed. A closed migration cannot be reopened; its record stays.',
    'de-CH': 'Schliesst die Datenübernahme als erledigt ab, sobald jeder Schritt fertig und keine Prüfung fehlgeschlagen ist. Eine abgeschlossene Übernahme lässt sich nicht wieder öffnen; ihre Unterlagen bleiben.',
    reversibility: 'final',
  },

  // Owner decision 11.10.2026 (restoring G09.6). Verified against `abandonPlan`: it refuses only a
  // closed plan, sets `abandoned`, and deletes the Testmandant only when this plan OWNS it and it is
  // still a sandbox (`owningPlan`, the one guarded delete path shared with `discard_testmandant`); a
  // copy's plan only drops its link. The source files it reports as retained stay, `closePlan` then
  // refuses `plan_not_live`, and no step is rolled back. Governed under `erase` since it deletes.
  migration_abandon_plan: {
    // Conditional on purpose (critic, 11.10.2026): abandon stays open on a live plan, and a Testmandant
    // that went productive IS the books, which `abandonPlan` never deletes.
    en: 'Abandons the data migration and deletes the trial workspace these books created for good, while it is still a trial; one that went productive is your books and stays. Belege of committed steps stay.',
    'de-CH': 'Bricht die Datenübernahme ab und löscht den Testmandanten, den diese Bücher angelegt haben, endgültig, solange er ein Test ist; ging er produktiv, sind es deine Bücher und er bleibt. Belege bleiben.',
    reversibility: 'final',
  },

  // Verified against `recordApproval`: the row binds to the step's CURRENT check hash, a stale hash is
  // refused, and a rollback (returnToMapped) deletes it; `commitStep` requires it for money classes.
  migration_record_approval: {
    en: "Records your approval of this step's current check result, which lets the step be committed to your live books. The approval holds for this result only; a rollback voids it.",
    'de-CH': 'Hält deine Freigabe des aktuellen Prüfergebnisses dieses Schritts fest; damit darf der Schritt in die echten Bücher übernommen werden. Die Freigabe gilt nur für dieses Ergebnis; ein Zurücknehmen hebt sie auf.',
    reversibility: 'correctable',
  },

  // --- pay: a Bankkonto's payment details (input-keyed, D156.3) ---------------------------------
  // Verified against `updateBankAccount`: the three fields freeze once a posted opening balance
  // references the account (`account_in_use`), so "change them back" holds only until then.
  update_bank_account: {
    en: "Changes this bank account's IBAN, currency or ledger account; later payment runs and bank bookings use the new details. You can change them back until an opening balance is posted on it.",
    'de-CH': 'Ändert IBAN, Währung oder Buchhaltungskonto dieses Bankkontos; spätere Zahlungsläufe und Bankbuchungen verwenden die neuen Angaben. Zurückändern geht, bis darauf ein Eröffnungssaldo gebucht ist.',
    reversibility: 'reversible',
  },

  // --- share: data leaving the machine, outside access (D156.3) ----------------------------------
  // Verified: `enableSyncPublish` backfills the posted history into the outbox; `disableSyncPublish`
  // stops it and keeps the rows. A vendor grant is live once minted (`createVendorGrant` stamps
  // `sent_at` at mint, D157 owner decision 2), clamped to `PORTAL_MAX_VALIDITY_DAYS` (90), revocable
  // by `vendor_portal_revoke`.
  sync_publish_enable: {
    en: "Turns on publishing: your postings, past ones included, can then be read from this workspace's sync stream. You can turn it off again, but whatever was read stays with the reader for good.",
    'de-CH': 'Schaltet die Veröffentlichung ein: deine Buchungen, auch frühere, lassen sich dann aus dem Sync-Stream lesen. Ausschalten geht wieder, aber was schon gelesen wurde, bleibt endgültig beim Leser.',
    reversibility: 'final',
  },
  vendor_portal_grant: {
    en: 'Gives this supplier a link to their own purchase orders and payment advices, for at most 90 days. You can revoke it at any time; what they already saw cannot be taken back.',
    'de-CH': 'Gibt diesem Lieferanten einen Link zu seinen Bestellungen und Zahlungsavis, für höchstens 90 Tage. Du kannst den Zugang jederzeit widerrufen; was er schon gesehen hat, lässt sich nicht zurücknehmen.',
    // Critic N5: final like portal_grant_send (the stricter class): the link is live at mint, and a
    // revoke ends access but cannot take back what the supplier already saw.
    reversibility: 'final',
  },

  // --- D156 critic F2: outside access and outbound documents ------------------------------------
  // Verified (D157): a customer grant is minted as a draft whose token resolves to nothing (`isLive`
  // requires the hand-over); the send stamps `sent_at`, which is what opens the scoped records, and
  // emails nothing in the MIT core (`sent:false`, cloud tier); `portal_grant_revoke` ends access and
  // keeps the row. `portal_grant_create` left the dial (NOT_DIAL_GOVERNED) and, like every ungoverned
  // write, carries no sentence (`ConsequenceLine` renders nothing for it). quotes_send
  // freezes the quote, mints the accept token and returns the PDF and link (`transmitted:false`);
  // quotes_revise is the change path; sign_requests_send needs a provider (`needs_provider` keeps it a
  // draft) and sign_requests_withdraw is the way back from sent; bank_channel_disconnect retires or
  // blocks a channel.
  portal_grant_send: {
    en: "Activates the customer's portal link: from now on it opens the records it names, and TILL itself emails nothing. You can revoke the access, but what they saw can't be taken back.",
    'de-CH': 'Schaltet den Portal-Link der Kundschaft frei: Ab jetzt öffnet er die genannten Belege, und TILL selbst verschickt nichts. Du kannst den Zugang widerrufen, Gesehenes lässt sich aber nicht zurückholen.',
    reversibility: 'final',
  },
  ebill_transmit: {
    en: "Transmits the invoice as an eBill into the customer's e-banking through the connected eBill service. Once it is out, it can't be called back; a correction goes out separately.",
    'de-CH': 'Übermittelt die Rechnung als eBill über den verbundenen eBill-Dienst ins E-Banking der Kundschaft. Ist sie draussen, lässt sie sich nicht zurückholen; eine Korrektur geht separat hinterher.',
    reversibility: 'final',
  },
  quotes_send: {
    en: 'Numbers the quote, freezes it and makes its online accept link; TILL hands you the PDF and the link and emails nothing itself. To change it later, you revise it into a new version.',
    'de-CH': 'Nummeriert die Offerte, friert sie ein und erstellt ihren Annahme-Link; TILL gibt dir PDF und Link und verschickt selbst nichts. Ändern kannst du sie danach nur als neue Version.',
    reversibility: 'correctable',
  },
  sign_requests_send: {
    en: "Sends the document to the e-signing service for signature; with no service connected, nothing leaves and it stays a draft. What was sent can't be called back; you can still withdraw the request.",
    'de-CH': 'Schickt das Dokument zur Unterschrift an den E-Signatur-Dienst; ohne verbundenen Dienst verlässt nichts den Rechner. Was gesendet wurde, lässt sich nicht zurückholen; die Anfrage kannst du zurückziehen.',
    reversibility: 'final',
  },
  bank_channel_connect: {
    en: "Opens a channel to your bank: TILL makes the keys and sends the bank its setup, then statements (on the managed rail also payments) flow over it. What the bank got can't be recalled; you can retire or block the channel.",
    'de-CH': 'Öffnet einen Kanal zu deiner Bank: TILL erzeugt die Schlüssel und schickt der Bank die Einrichtung, danach fliessen Auszüge. Was die Bank erhielt, lässt sich nicht zurückholen; stilllegen oder sperren kannst du ihn.',
    reversibility: 'final',
  },

  // --- erase: gone for good (D156.3/.4) ----------------------------------------------------------
  // Each sentence names what goes and what stays, then that there is no way back or the one way to
  // have it again (create it anew). Every "only", "stays" and "never" was checked against the verb's
  // own refusal: the delete verbs refuse a referenced or non-draft row, so the sentence says so.
  contacts_anonymise: {
    en: "Erases this person's personal data and the notes about them, merged duplicates included, once nothing is still open with them. Booked documents stay on record without those details; there is no way back.",
    'de-CH': 'Löscht die Personendaten und Notizen zu dieser Person, zusammengeführte Duplikate eingeschlossen, sobald mit ihr nichts mehr offen ist. Gebuchte Dokumente bleiben ohne diese Angaben; zurück geht es nicht.',
    reversibility: 'final',
  },
  contacts_merge: {
    en: "Moves the duplicate's documents, activities and links onto the contact you keep, and retires the duplicate. A merge cannot be split again.",
    'de-CH': 'Überträgt Dokumente, Aktivitäten und Verknüpfungen des Duplikats auf den Kontakt, den du behältst, und legt das Duplikat still. Eine Zusammenführung lässt sich nicht wieder trennen.',
    reversibility: 'final',
  },
  files_delete: {
    en: 'Deletes the file and its contents for good; a file still under retention cannot be deleted. TILL keeps no copy, so keep your own if you may need it.',
    'de-CH': 'Löscht die Datei samt Inhalt endgültig; eine Datei in der Aufbewahrungsfrist lässt sich nicht löschen. TILL behält keine Kopie, bewahre also selbst eine auf, wenn du sie brauchen könntest.',
    reversibility: 'final',
  },
  delete_account: {
    en: 'Deletes the account from your chart for good; only an account that never carried a booking can go. You can create it again, but not restore it.',
    'de-CH': 'Löscht das Konto endgültig aus dem Kontenplan; das geht nur bei einem Konto ohne Buchung. Du kannst es neu anlegen, aber nicht wiederherstellen.',
    reversibility: 'final',
  },
  delete_cost_center: {
    en: 'Deletes the cost centre for good; only one that no booking uses can go. You can create it again, but not restore it.',
    'de-CH': 'Löscht die Kostenstelle endgültig; das geht nur, wenn keine Buchung sie verwendet. Du kannst sie neu anlegen, aber nicht wiederherstellen.',
    reversibility: 'final',
  },
  delete_draft: {
    en: 'Deletes the unposted draft entry for good; nothing was booked. To book it after all, you enter it again.',
    'de-CH': 'Löscht den ungebuchten Buchungsentwurf endgültig; gebucht wurde nichts. Willst du ihn doch buchen, erfasst du ihn neu.',
    reversibility: 'final',
  },
  delete_item: {
    en: 'Deletes the item for good; only an item nothing refers to can go. You can create it again, but not restore it.',
    'de-CH': 'Löscht den Artikel endgültig; das geht nur, wenn nichts auf ihn verweist. Du kannst ihn neu anlegen, aber nicht wiederherstellen.',
    reversibility: 'final',
  },
  item_categories_delete: {
    en: 'Deletes the item category for good; only one that no item or subcategory points at can go. You can create it again.',
    'de-CH': 'Löscht die Artikelkategorie endgültig; das geht nur, wenn kein Artikel und keine Unterkategorie darauf zeigt. Du kannst sie neu anlegen.',
    reversibility: 'final',
  },
  price_lists_delete: {
    en: 'Deletes the price list and all its dated prices for good. Documents already made keep the prices they used; the list itself cannot be restored.',
    'de-CH': 'Löscht die Preisliste mit allen datierten Preisen endgültig. Bestehende Dokumente behalten ihre Preise; die Liste selbst lässt sich nicht wiederherstellen.',
    reversibility: 'final',
  },
  price_lists_unset_price: {
    en: "Removes the item's price from the list for good, one dated price or all of them. Documents already made keep their prices; to have it back, you enter the price again.",
    'de-CH': 'Entfernt den Preis des Artikels endgültig aus der Liste, einen datierten oder alle. Bestehende Dokumente behalten ihre Preise; sonst erfasst du den Preis neu.',
    reversibility: 'final',
  },
  sign_requests_delete_draft: {
    en: 'Deletes the unsent signature request draft for good; nothing went out. You can start a new request.',
    'de-CH': 'Löscht den ungesendeten Entwurf der Signaturanfrage endgültig; verschickt wurde nichts. Du kannst eine neue Anfrage starten.',
    reversibility: 'final',
  },
  time_delete: {
    en: 'Deletes the time entry for good; approved, locked or billed time cannot be deleted. To have it back, you record it again.',
    'de-CH': 'Löscht den Zeiteintrag endgültig; genehmigte, gesperrte oder verrechnete Zeit lässt sich nicht löschen. Brauchst du ihn wieder, erfasst du ihn neu.',
    reversibility: 'final',
  },
  project_delete: {
    en: 'Deletes the draft project and its phases for good; a project past draft is closed instead. You can create it again, but not restore it.',
    'de-CH': 'Löscht das Projekt im Entwurf samt Phasen endgültig; ein Projekt nach dem Entwurf wird abgeschlossen statt gelöscht. Du kannst es neu anlegen, aber nicht wiederherstellen.',
    reversibility: 'final',
  },
  // Verified against `discardTestmandant`: it deletes only a sandbox this plan OWNS (`owningPlan`); a
  // copy of the books whose plan links the original's Testmandant only drops its own link.
  discard_testmandant: {
    en: "Deletes the trial workspace these books created, and everything in it, for good; a copy never deletes the original's. Your live books and the migration plan stay, so you can load a new trial.",
    'de-CH': 'Löscht den Testmandanten, den diese Bücher angelegt haben, mit allem darin endgültig; eine Kopie löscht nie den des Originals. Deine echte Buchhaltung und der Plan bleiben, du kannst neu testen.',
    reversibility: 'final',
  },
  // Verified against `discardOrphanTestmandant`: only a sandbox no plan links, only the one named.
  discard_orphan_testmandant: {
    en: 'Deletes this trial workspace, which no migration plan uses any more, and everything in it for good. Your live books are never touched.',
    'de-CH': 'Löscht diesen Testmandanten, den kein Migrationsplan mehr nutzt, mit allem darin endgültig. Deine echte Buchhaltung bleibt unberührt.',
    reversibility: 'final',
  },
  discard_demo_workspace: {
    en: 'Deletes the demo workspace and everything in it for good, your own experiments included. A live workspace can never be deleted this way.',
    'de-CH': 'Löscht den Demo-Arbeitsbereich mit allem darin endgültig, auch deine eigenen Versuche. Ein echter Arbeitsbereich lässt sich so nie löschen.',
    reversibility: 'final',
  },
  gl_archive_purge: {
    en: 'Deletes archived periods whose ten-year retention has run out, with your reason; a purge record stays in their place. The purged data cannot be restored.',
    'de-CH': 'Löscht archivierte Perioden, deren zehnjährige Aufbewahrungsfrist abgelaufen ist, mit deiner Begründung; ein Löschvermerk bleibt an ihrer Stelle. Gelöschtes lässt sich nicht wiederherstellen.',
    reversibility: 'final',
  },
  env_reset: {
    en: 'Wipes the environment and fills it again from its data policy; your main books are never reset. What it held before is gone for good.',
    'de-CH': 'Leert die Umgebung und befüllt sie neu nach ihrer Datenregel; deine Hauptbuchhaltung wird nie zurückgesetzt. Was vorher darin war, ist endgültig weg.',
    reversibility: 'final',
  },
  env_delete: {
    en: 'Removes the environment and its data for good; your main books can never be deleted. To have one again, you create a new environment.',
    'de-CH': 'Entfernt die Umgebung samt Daten endgültig; deine Hauptbuchhaltung lässt sich nie löschen. Brauchst du wieder eine, legst du eine neue Umgebung an.',
    reversibility: 'final',
  },
  env_copy: {
    en: 'Replaces the data of a lower environment with a copy from a higher one, sanitised as you choose; your main books are never the target. What the target held before is gone for good.',
    'de-CH': 'Ersetzt die Daten einer tieferen Umgebung durch eine Kopie aus einer höheren, bereinigt nach deiner Wahl; deine Hauptbuchhaltung ist nie das Ziel. Was das Ziel enthielt, ist endgültig weg.',
    reversibility: 'final',
  },
  delete_backup: {
    en: "Deletes the backup or export file and its history entry for good; your books are untouched. A new backup holds today's books, never the deleted snapshot.",
    'de-CH': 'Löscht die Sicherungs- oder Exportdatei und ihren Verlaufseintrag endgültig; deine Buchhaltung bleibt unberührt. Eine neue Sicherung enthält den heutigen Stand, nie den gelöschten.',
    reversibility: 'final',
  },
  reports_delete: {
    en: 'Deletes the report with its run history and stops its schedule. Documents filed from its runs stay in your files; the report itself cannot be restored.',
    'de-CH': 'Löscht den Bericht mit seinem Verlauf und stoppt seinen Zeitplan. Abgelegte Dokumente aus seinen Läufen bleiben in deinen Dateien; der Bericht selbst lässt sich nicht wiederherstellen.',
    reversibility: 'final',
  },

  // D158 critic round 1. `approve_entry` (A25 `approveEntry`): appends an `approved` review event and
  // touches no entry; the status is the latest event, so a later `flag_entry` supersedes it while the
  // sign-off row stays. `match_bill` (D02 `matchBill`): raises billed_qty to the received quantity,
  // closes a fully billed received order, posts nothing, and no verb unmatches a `po_match`.
  approve_entry: {
    en: 'Signs off this posted entry as checked, in your name; the entry itself does not change. A later flag on the entry reopens the question, and the sign-off stays on record.',
    'de-CH': 'Gibt diese gebuchte Buchung als geprüft frei, in deinem Namen; die Buchung selbst bleibt unverändert. Eine spätere Markierung stellt sie wieder in Frage, die Freigabe bleibt erhalten.',
    reversibility: 'correctable',
  },
  match_bill: {
    en: "Matches the vendor bill against what the order received and marks those lines billed; a fully billed order closes. Nothing is booked, and the match can't be undone.",
    'de-CH': 'Gleicht die Lieferantenrechnung mit dem Wareneingang der Bestellung ab und markiert die Positionen als verrechnet; ist alles verrechnet, schliesst die Bestellung. Gebucht wird nichts; aufheben lässt sich das nicht.',
    reversibility: 'final',
  },

  // The map's class for the install: uninstalling or disabling it is the correction, and what the code
  // already did stays done (the family sentence stays `reversible` for the enable it also covers).
  install_plugin: {
    en: 'Installs third-party code that runs with the rights you grant. A wrong install is undone by disabling or uninstalling it; what it already did stays done.',
    'de-CH': 'Installiert Code von Dritten, der mit den Rechten läuft, die du gewährst. Eine falsche Installation deaktivierst oder deinstallierst du; was der Code schon tat, bleibt bestehen.',
    reversibility: 'correctable',
  },

  // --- G22 checklists: each states what it records (only `checklist_abandon` is governed by name) ---
  checklist_start: {
    en: 'Starts the checklist for the period with every item and its due date. A run started by mistake is abandoned, never deleted.',
    'de-CH': 'Startet die Checkliste für die Periode mit jedem Punkt und seiner Frist. Einen irrtümlich gestarteten Lauf brichst du ab; gelöscht wird er nie.',
    reversibility: 'correctable',
  },
  checklist_item_complete: {
    en: 'Records the item as done under your name, with the evidence TILL computed or the sign-off you give. Most items can be reopened; a voided sign-off stays on record.',
    'de-CH': 'Hakt den Punkt in deinem Namen ab, mit dem Nachweis, den TILL berechnet hat, oder deiner Bestätigung. Die meisten Punkte lassen sich wieder öffnen; eine aufgehobene Bestätigung bleibt erhalten.',
    reversibility: 'correctable',
  },
  // D161: both governed under close-period, and `correctable` per the map: neither act is erased by the
  // next one. A skip voids a live sign-off (kept as history) and stays in the audit log; a reopen voids
  // the sign-off with reason `reopened`. The correction is the next act beside the first.
  checklist_item_skip: {
    en: 'Marks the item as not applicable with your reason and voids any sign-off on it; both stay visible in the run and the audit log. You can reopen the item later.',
    'de-CH': 'Markiert den Punkt mit deiner Begründung als nicht zutreffend und hebt eine Bestätigung darauf auf; beides bleibt im Lauf und im Protokoll sichtbar. Du kannst ihn später wieder öffnen.',
    reversibility: 'correctable',
  },
  checklist_item_reopen: {
    en: 'Reopens the item and voids its sign-off, which stays on record as voided. You can complete the item again.',
    'de-CH': 'Öffnet den Punkt wieder und hebt seine Bestätigung auf; sie bleibt als aufgehoben erhalten. Du kannst den Punkt erneut abhaken.',
    reversibility: 'correctable',
  },
  // D158: governed under close-period. Verified: a run is unique per template and period
  // (`checklist_run_one_per_period`), and `checklist_start` hands the abandoned run back for its period,
  // so the earlier "start the right period as a new run" overpromised for the period abandoned.
  checklist_abandon: {
    en: "Abandons the run with your reason; it stays listed and stops asking for anything. It can't be resumed, and this checklist gets no new run for that period.",
    'de-CH': 'Bricht den Lauf mit deiner Begründung ab; er bleibt aufgelistet und erscheint nicht mehr in den Pendenzen. Fortsetzen geht nicht, und für diese Periode gibt es keinen neuen Lauf dieser Checkliste.',
    reversibility: 'final',
  },

  // --- D161: the approval map. Each entry below was checked against the engine verb it names, and its
  // `reversibility` is the class `docs/planning/reversibility/map.json` gives the verb.
  //
  // vat-file: the MWST elections. `setVatMethod` overwrites two workspace columns.
  set_vat_method: {
    en: 'Changes how MWST is worked out for your returns: effective or net tax rate method, agreed or received payments. You can set it back, but the earlier setting is not kept.',
    'de-CH': 'Ändert, wie die MWST für deine Abrechnungen ermittelt wird: effektive oder Saldosteuersatz-Methode, vereinbarte oder vereinnahmte Entgelte. Zurückstellen geht, die frühere Einstellung bleibt nicht erhalten.',
    reversibility: 'reversible',
  },
  // `vatConfigure` keeps every approval generation; an in-place rewrite of one a filed period used is
  // refused (`saldo_generation_filed`) and the hint is a new approval from the first unfiled day.
  vat_configure: {
    en: 'Sets your MWST registration, method, timing, VAT number and ESTV approval. Earlier approvals stay on record; one already used for a filed period is not rewritten, you record a new one.',
    'de-CH': 'Legt MWST-Pflicht, Methode, Abrechnungsart, MWST-Nummer und ESTV-Bewilligung fest. Frühere Bewilligungen bleiben erhalten; eine für eine eingereichte Periode verwendete wird nicht überschrieben.',
    reversibility: 'correctable',
  },
  // Refused once any period of the Steuerperiode is filed (`saldo_declaration_basis_filed`).
  vat_saldo_declaration_basis: {
    en: "Chooses whether this tax year's net-rate turnover is declared at the highest approved rate or split per activity; the first usually raises the tax. You can withdraw it until a period of the year is filed.",
    'de-CH': 'Wählt, ob der Umsatz dieses Steuerjahres zum höchsten bewilligten Saldosteuersatz oder je Tätigkeit abgerechnet wird; ersteres erhöht meist die Steuer. Widerrufen geht, bis eine Periode eingereicht ist.',
    reversibility: 'reversible',
  },
  // MWSTV Art. 45 Abs. 5: the election carries forward until changed, and is refused once the period or a
  // later one holds a posted foreign-currency entry.
  set_fx_method: {
    en: 'Chooses the exchange-rate basis MWST uses for foreign-currency amounts from this tax year on. You can change it only while that year and later ones hold no posted foreign-currency entry.',
    'de-CH': 'Wählt die Kursbasis, mit der die MWST Fremdwährungsbeträge ab diesem Steuerjahr umrechnet. Ändern geht nur, solange dieses und spätere Jahre keine gebuchte Fremdwährungsbuchung enthalten.',
    reversibility: 'reversible',
  },
  // Input-keyed on `mwstNo` (D161.3). `invoice.ts` reads `workspace.mwst_no` live into the Swico billing
  // information of every QR-bill it renders.
  update_company_profile: {
    en: 'Changing the MWST number also changes it on the QR-bills of open invoices when they are downloaded or sent again. You can change it back; what customers already received keeps the old number.',
    'de-CH': 'Eine geänderte MWST-Nummer erscheint auch auf den QR-Rechnungen offener Rechnungen, wenn du sie erneut herunterlädst oder sendest. Zurückändern geht; was Kunden schon erhielten, behält die alte.',
    reversibility: 'reversible',
  },
  // customize: the rate table. A different rate under the same date and source is refused, because it may
  // already have priced a posted entry; the rate row is never edited.
  record_exchange_rate: {
    en: 'Records an exchange rate for its date; foreign-currency entries on that date then use it. The rate stays on record unchanged; an entry it priced wrongly is fixed with a correcting entry.',
    'de-CH': 'Erfasst einen Wechselkurs für sein Datum; Fremdwährungsbuchungen an diesem Tag verwenden ihn. Der Kurs bleibt unverändert erhalten; eine damit falsch bewertete Buchung korrigierst du mit einer Korrekturbuchung.',
    reversibility: 'correctable',
  },
  import_exchange_rates: {
    en: 'Imports the published BAZG exchange rates into your rate list, each on the dates it is valid for. Imported rates stay unchanged; an entry one priced wrongly is fixed with a correcting entry.',
    'de-CH': 'Übernimmt die publizierten BAZG-Kurse in deine Kursliste, jeden für die Tage, an denen er gilt. Importierte Kurse bleiben unverändert; eine damit falsch bewertete Buchung korrigierst du mit einer Korrekturbuchung.',
    reversibility: 'correctable',
  },
  // `archiveRole` sets `archived = 1` (never a delete) and refuses `role_in_use`.
  archive_role: {
    en: 'Stops offering this custom role; it is refused while anyone still holds it, and past actions keep their role. You can define a role with the same rights again.',
    'de-CH': 'Bietet diese eigene Rolle nicht mehr an; solange sie jemand hat, geht das nicht, und frühere Handlungen behalten ihre Rolle. Eine Rolle mit denselben Rechten kannst du neu definieren.',
    reversibility: 'correctable',
  },
  update_document_template: {
    en: 'Changes the template for documents issued from now on; documents already issued keep the look they were issued with. You can change it again.',
    'de-CH': 'Ändert die Vorlage für künftig ausgestellte Dokumente; bereits ausgestellte behalten ihr Aussehen. Du kannst sie wieder ändern.',
    reversibility: 'correctable',
  },
  set_default_document_template: {
    en: 'Makes this template the default for its kind of document, for everything issued from now on; issued documents keep theirs. You can choose another default at any time.',
    'de-CH': 'Macht diese Vorlage zum Standard für ihre Dokumentart, für alles, was ab jetzt ausgestellt wird; Ausgestelltes behält seine. Einen anderen Standard wählst du jederzeit.',
    reversibility: 'correctable',
  },
  dispatch_text_upsert: {
    en: 'Saves the email text for this kind of document and language; messages sent from now on use it. You can edit it again or reset it to the built-in text.',
    'de-CH': 'Speichert den E-Mail-Text für diese Dokumentart und Sprache; künftige Nachrichten verwenden ihn. Du kannst ihn wieder ändern oder auf den Standardtext zurücksetzen.',
    reversibility: 'reversible',
  },
  // Critic round 3 (N2): governed, state-keyed, when the slot holds a person's saved text.
  dispatch_text_reset: {
    en: 'Deletes the saved email text for this kind of document and language; messages from now on use the built-in text. To get your text back, it has to be saved again.',
    'de-CH': 'Löscht den gespeicherten E-Mail-Text für diese Dokumentart und Sprache; künftige Nachrichten verwenden wieder den Standardtext. Deinen Text bekommst du nur zurück, wenn du ihn neu speicherst.',
    reversibility: 'reversible',
  },
  // It re-sends the stored input with its derived idempotency key, as the actor the firing ran as.
  retry_automation_run: {
    en: 'Finishes an automation run that was cut off, sending its stored step again in the name it ran under. What it does stays done; the same step never runs twice.',
    'de-CH': 'Schliesst einen abgebrochenen Automatisierungslauf ab und sendet seinen gespeicherten Schritt erneut im selben Namen. Was er tut, bleibt getan; derselbe Schritt läuft nie doppelt.',
    reversibility: 'final',
  },
  // Input-keyed: every agent-seat call. The `till up` scheduler runs it as `system` through `action.run`.
  run_due_automations: {
    en: "Runs every enabled automation whose schedule is due, each in its author's name and unattended. What they do can't be undone by TILL; you stop a rule by disabling it.",
    'de-CH': 'Führt jede aktive Automatisierung aus, deren Zeitplan fällig ist, jede im Namen ihres Urhebers und unbeaufsichtigt. Was sie tun, macht TILL nicht rückgängig; eine Regel stoppst du, indem du sie deaktivierst.',
    reversibility: 'final',
  },
  // pay: the bank feed, the payment runs before they are paid, the match, the payee data.
  bank_sync: {
    en: 'Fetches new day-end statements from your bank and imports them; each new bank line waits in the bank inbox and nothing is booked. The bank gets its receipt, and an import cannot be taken back.',
    'de-CH': 'Holt neue Tagesend-Auszüge von deiner Bank und importiert sie; jede neue Bankzeile wartet im Bankeingang, gebucht wird nichts. Die Bank erhält ihre Quittung; ein Import lässt sich nicht zurücknehmen.',
    reversibility: 'final',
  },
  // `updateBankAccount` freezes the IBAN, currency and ledger account once a posted opening balance
  // references the account (`account_in_use`); `archive_bank_account` never deletes it.
  create_bank_account: {
    en: 'Registers a bank account with its IBAN and ledger account, so payment runs and bank imports can use it; nothing is booked. You can fix its details until an opening balance is posted, or archive it.',
    'de-CH': 'Erfasst ein Bankkonto mit IBAN und Buchhaltungskonto, damit Zahlungsläufe und Bankimporte es nutzen; gebucht wird nichts. Korrigieren geht bis zum Eröffnungssaldo, archivieren immer.',
    reversibility: 'correctable',
  },
  record_incoming_credit: {
    en: 'Adds a received payment to the matching queue and suggests the invoices it may pay; nothing is booked yet. If it is matched wrongly, you point it at another invoice or take it out of the match.',
    'de-CH': 'Nimmt eine eingegangene Zahlung in die Abgleich-Warteschlange und schlägt passende Rechnungen vor; gebucht wird noch nichts. Passt die Zuordnung nicht, ordnest du sie neu zu oder löst sie.',
    reversibility: 'correctable',
  },
  set_qr_auto_apply: {
    en: 'Turns automatic settling on or off: when on, a received payment whose reference and amount match exactly settles its invoice with no separate confirmation. You can turn it off at any time.',
    'de-CH': 'Schaltet das automatische Begleichen ein oder aus: eingeschaltet begleicht eine Zahlung mit genau passender Referenz und Betrag ihre Rechnung ohne eigene Bestätigung. Ausschalten geht jederzeit.',
    reversibility: 'reversible',
  },
  import_camt: {
    en: 'Imports the bank statement: each new bank line waits in the bank inbox, and nothing is booked yet. An imported statement cannot be taken out again; a line booked wrongly is reopened and corrected.',
    'de-CH': 'Importiert den Kontoauszug: jede neue Bankzeile wartet im Bankeingang, gebucht wird noch nichts. Ein importierter Auszug lässt sich nicht entfernen; eine falsch gebuchte Zeile öffnest du wieder und korrigierst sie.',
    reversibility: 'final',
  },
  import_camt_files: {
    en: 'Imports several bank statements in number order to close a gap; each new bank line waits in the bank inbox, and nothing is booked yet. Imported statements cannot be taken out again.',
    'de-CH': 'Importiert mehrere Kontoauszüge in Nummernfolge, um eine Lücke zu schliessen; jede neue Bankzeile wartet im Bankeingang, gebucht wird nichts. Importierte Auszüge lassen sich nicht entfernen.',
    reversibility: 'final',
  },
  create_payment_batch: {
    en: 'Drafts a payment run from the selected open bills; nothing is paid or sent yet. You can discard the draft, and its bills become payable again.',
    'de-CH': 'Entwirft einen Zahlungslauf aus den gewählten offenen Rechnungen; bezahlt oder versendet wird noch nichts. Du kannst den Entwurf verwerfen, die Rechnungen sind dann wieder zahlbar.',
    reversibility: 'correctable',
  },
  generate_pain001: {
    en: 'Builds the payment file for the run, ready to upload in your e-banking; TILL sends nothing to the bank. You can still discard the run, which makes its bills payable again.',
    'de-CH': 'Erstellt die Zahlungsdatei des Laufs für den Upload im E-Banking; TILL schickt der Bank nichts. Du kannst den Lauf noch verwerfen, die Rechnungen sind dann wieder zahlbar.',
    reversibility: 'correctable',
  },
  // `discardPaymentBatch` moves the batch to `discarded` and deletes no row; a paid batch is refused.
  discard_payment_batch: {
    en: 'Discards the payment run, so its bills become payable again; the run stays on record as discarded. If you already uploaded its file at your bank, cancel the order there too.',
    'de-CH': 'Verwirft den Zahlungslauf, seine Rechnungen sind wieder zahlbar; der Lauf bleibt als verworfen erhalten. Hast du die Datei schon bei der Bank hochgeladen, widerrufe den Auftrag auch dort.',
    reversibility: 'correctable',
  },
  liquidity_plan_draft_batches: {
    en: 'Drafts one payment run per proposed date from the liquidity plan; nothing is paid or sent yet. You can discard any of the drafts, and their bills become payable again.',
    'de-CH': 'Entwirft aus dem Liquiditätsplan einen Zahlungslauf je vorgeschlagenem Datum; bezahlt oder versendet wird nichts. Jeden Entwurf kannst du verwerfen, die Rechnungen sind dann wieder zahlbar.',
    reversibility: 'correctable',
  },
  match_three_way_create: {
    en: 'Matches the vendor bill against its order and goods receipts and marks those lines billed; nothing is booked. A wrong match is reversed, and both stay on record.',
    'de-CH': 'Gleicht die Lieferantenrechnung mit Bestellung und Wareneingang ab und markiert die Positionen als verrechnet; gebucht wird nichts. Eine falsche Zuordnung nimmst du zurück; beides bleibt erhalten.',
    reversibility: 'correctable',
  },
  match_three_way_override: {
    en: 'Forces the match despite differences beyond the tolerance, with your reason, and marks those lines billed; nothing is booked. Only reversing the match undoes it, and both stay on record.',
    'de-CH': 'Erzwingt den Abgleich trotz Abweichungen über der Toleranz, mit deiner Begründung, und markiert die Positionen als verrechnet; gebucht wird nichts. Nur eine Rücknahme hebt ihn auf; beides bleibt.',
    reversibility: 'correctable',
  },
  match_three_way_reverse: {
    en: 'Reverses the match and restores the billed quantities; the original match stays on record as reversed. To match again, you run a fresh check and match.',
    'de-CH': 'Nimmt den Abgleich zurück und stellt die verrechneten Mengen wieder her; der ursprüngliche Abgleich bleibt als zurückgenommen erhalten. Neu abgleichen geht mit einer neuen Prüfung.',
    reversibility: 'correctable',
  },
  // D161.3: under pay. It governs the offer only (a product setting, not a rounding rule).
  set_write_off_threshold: {
    en: 'Sets the leftover amount below which the Studio offers a one-click write-off of an open item. Larger write-offs stay possible when stated deliberately; you can change the amount again.',
    'de-CH': 'Legt den Restbetrag fest, unter dem das Studio eine Ausbuchung mit einem Klick anbietet. Grössere Ausbuchungen bleiben bewusst möglich; den Betrag kannst du wieder ändern.',
    reversibility: 'reversible',
  },
  // D161.3: governed, the approval of a money commitment. It appends an immutable approval event;
  // `requisition_cancel` takes an approved request with no conversion yet.
  requisition_approve: {
    en: 'Approves your step of this purchase request; once every required approval is in, it can be ordered. The approval stays on record; a request no longer needed is cancelled while nothing was ordered from it.',
    'de-CH': 'Genehmigt deinen Schritt dieser Bestellanforderung; liegen alle nötigen Genehmigungen vor, kann bestellt werden. Die Genehmigung bleibt; eine unnötige Anforderung brichst du ab, solange nichts bestellt ist.',
    reversibility: 'correctable',
  },
  // D161.3, under erase. `disconnectBankChannel` destroys the keys in the keystore on `retire` and flips
  // the connection terminal; `bank_channel_connect` then mints a NEW connection (it reads only
  // non-retired rows). `block` is local only and sends nothing to the bank.
  bank_channel_disconnect: {
    en: 'Retiring ends this bank channel and destroys its keys for good; blocking only stops TILL using it. Its order history stays readable, and a retired channel cannot reopen: connecting again makes new keys.',
    'de-CH': 'Stilllegen beendet diesen Bankkanal und vernichtet seine Schlüssel endgültig; Sperren stoppt nur die Nutzung durch TILL. Der Verlauf bleibt lesbar; ein stillgelegter Kanal öffnet nie wieder.',
    reversibility: 'final',
  },
  agent_prose_delete: {
    en: 'Deletes the words of this agent conversation for good; the record of what the agent did stays. The text cannot be restored.',
    'de-CH': 'Löscht die Texte dieses Agentengesprächs endgültig; das Protokoll dessen, was der Agent getan hat, bleibt. Der Text lässt sich nicht wiederherstellen.',
    reversibility: 'final',
  },
  // `reindexMailStore` deletes index rows of messages gone from the store, then their empty threads with
  // the drafts and field values on them, and the voice exemplars derived from them.
  mail_reindex: {
    en: 'Reads the mail store again and updates the index; messages you deleted in your mail client leave it, with their drafts and writing samples, for good. The mail store itself is never changed.',
    'de-CH': 'Liest den Mail-Speicher neu ein; Nachrichten, die du im Mailprogramm gelöscht hast, verlassen den Index endgültig, samt Entwürfen und Schreibproben. Der Mail-Speicher selbst bleibt unverändert.',
    reversibility: 'final',
  },
  // issue. A10 `TRANSITIONS`: an accepted quote has no edge out; only `convertDocument` takes it further.
  quotes_accept: {
    en: 'Marks the quote as accepted, which makes it binding, and spends its accept link. An accepted quote cannot be withdrawn or revised; the next step is turning it into an order or invoice.',
    'de-CH': 'Markiert die Offerte als angenommen; damit ist sie verbindlich, und ihr Annahme-Link erlischt. Eine angenommene Offerte lässt sich weder zurückziehen noch überarbeiten, nur in Auftrag oder Rechnung umwandeln.',
    reversibility: 'final',
  },
  // The portal door of the same accept (`portalQuoteAccept` delegates to C02's `acceptQuote`).
  portal_quote_accept: {
    en: "Accepts the quote through the customer's portal link, which makes it binding and spends that link. An accepted quote cannot be withdrawn or revised; the next step is turning it into an order or invoice.",
    'de-CH': 'Nimmt die Offerte über den Portal-Link der Kundschaft an; damit ist sie verbindlich, und der Link erlischt. Eine angenommene Offerte lässt sich weder zurückziehen noch überarbeiten, nur umwandeln.',
    reversibility: 'final',
  },
  // `signed` is terminal in `SIGN_REQUEST_TRANSITIONS`.
  sign_requests_complete: {
    en: 'Files the signed copy as a new version of the document and marks the request signed; the unsigned version stays kept. A signed request cannot be reopened.',
    'de-CH': 'Legt die unterschriebene Fassung als neue Version des Dokuments ab und markiert die Anfrage als unterschrieben; die vorherige Version bleibt. Eine unterschriebene Anfrage lässt sich nicht wieder öffnen.',
    reversibility: 'final',
  },
  resume_recurring_schedule: {
    en: 'Starts the recurring invoice again; the next run also makes the invoices that fell due while it was paused, issuing them if auto-issue is on. You can pause it again at any time.',
    'de-CH': 'Setzt die Serienrechnung fort; der nächste Lauf erstellt auch die während der Pause fälligen Rechnungen und stellt sie bei automatischem Ausstellen aus. Pausieren geht jederzeit wieder.',
    reversibility: 'reversible',
  },
  end_recurring_schedule: {
    en: 'Ends the recurring invoice for good: it makes no more invoices, and those already made stay as they are. To bill again, you set up a new schedule.',
    'de-CH': 'Beendet die Serienrechnung endgültig: sie erstellt keine Rechnungen mehr, bereits erstellte bleiben, wie sie sind. Für neue Rechnungen richtest du eine neue Serie ein.',
    reversibility: 'correctable',
  },
  // Input-keyed: every agent-seat call. A rule may not fire it (G01 denylist leg (e)).
  run_due_recurring: {
    en: 'Makes every recurring invoice that is due, and issues and books those whose schedule issues automatically. A wrong invoice is corrected with a credit note or a cancellation; the original stays on record.',
    'de-CH': 'Erstellt jede fällige Serienrechnung und stellt jene aus und bucht sie, deren Serie automatisch ausstellt. Eine falsche Rechnung korrigierst du mit einer Gutschrift oder stornierst sie; das Original bleibt.',
    reversibility: 'correctable',
  },
  // send: what a supplier or a person receives. `po_revise` reopens a sent order as a draft; `po_cancel`
  // takes it while nothing was received.
  po_send: {
    en: 'Marks the purchase order as sent and makes its PDF for you to pass on; TILL emails nothing itself. To change it afterwards, you revise it or cancel it.',
    'de-CH': 'Markiert die Bestellung als versendet und erstellt ihr PDF zum Weitergeben; TILL verschickt selbst nichts. Ändern kannst du sie danach nur, indem du sie überarbeitest oder stornierst.',
    reversibility: 'correctable',
  },
  po_amendment_apply: {
    en: 'Applies the change and makes the next version of the purchase order with a new PDF; TILL emails nothing itself. The earlier version stays on record; a further change is a new amendment.',
    'de-CH': 'Übernimmt die Änderung und erstellt die nächste Version der Bestellung mit neuem PDF; TILL verschickt selbst nichts. Die frühere Version bleibt erhalten; weitere Änderungen gehen als neue Änderung.',
    reversibility: 'correctable',
  },
  requisition_convert_to_po: {
    en: 'Turns the chosen quantities of the approved request into a purchase order, as a draft or already marked sent. A wrong order is revised or cancelled; its link to the request stays.',
    'de-CH': 'Macht aus den gewählten Mengen der genehmigten Anforderung eine Bestellung, als Entwurf oder gleich als versendet. Eine falsche Bestellung überarbeitest oder stornierst du; die Verknüpfung bleibt.',
    reversibility: 'correctable',
  },
  notifications_deliver: {
    en: "Puts a notice into this person's TILL inbox; nothing leaves TILL. It cannot be taken back, but they can mark it read or archive it.",
    'de-CH': 'Legt eine Mitteilung in den TILL-Posteingang dieser Person; nichts verlässt TILL. Zurücknehmen geht nicht, sie kann sie aber als gelesen markieren oder archivieren.',
    reversibility: 'final',
  },
  notifications_run_digest: {
    en: "Gathers this person's notices for the period into one digest for email or push; TILL itself transmits nothing yet. The digest stays on record and cannot be undone.",
    'de-CH': 'Fasst die Mitteilungen dieser Person für den Zeitraum für E-Mail oder Push zusammen; TILL selbst übermittelt noch nichts. Die Zusammenfassung bleibt erhalten.',
    reversibility: 'final',
  },
  // share: what a supplier sees in the portal, a report leaving the machine, access to the mail store.
  vendor_portal_remittance_create: {
    en: 'Creates a payment advice for this supplier payment; a supplier with portal access sees it at once. It cannot be withdrawn; a new advice for the same payment replaces it as the current one.',
    'de-CH': 'Erstellt ein Zahlungsavis zu dieser Lieferantenzahlung; ein Lieferant mit Portalzugang sieht es sofort. Zurückziehen geht nicht; ein neues Avis zur selben Zahlung löst es als aktuelles ab.',
    reversibility: 'final',
  },
  prepare_feedback: {
    en: 'Writes your feedback report, with diagnostics if you include them, to a file on this machine and returns a mail link for it. TILL sends nothing; once you send it, it cannot be called back.',
    'de-CH': 'Schreibt deinen Feedback-Bericht, auf Wunsch mit Diagnosedaten, in eine Datei auf diesem Rechner und gibt einen Mail-Link dazu. TILL sendet nichts; ist er verschickt, lässt er sich nicht zurückholen.',
    reversibility: 'final',
  },
  // No mail verb disconnects an account (`mail_account.enabled` has no writer verb).
  mail_connect: {
    en: 'Lets TILL read the mail store at this path on this machine; no password is asked and nothing leaves the machine. There is no disconnect yet, so the account stays connected.',
    'de-CH': 'Lässt TILL den Mail-Speicher an diesem Pfad auf diesem Rechner lesen; ein Passwort braucht es nicht, und nichts verlässt den Rechner. Trennen geht noch nicht; das Konto bleibt verbunden.',
    reversibility: 'final',
  },
  refresh_plugin_compat: {
    en: 'Checks the plugin against this TILL version and switches it off or back on. Switched back on, its third-party code runs with the rights you granted and what it does stays done; you can disable it again.',
    'de-CH': 'Prüft das Plugin gegen diese TILL-Version und schaltet es ab oder wieder ein. Eingeschaltet läuft sein Code von Dritten mit den gewährten Rechten, und was er tut, bleibt bestehen; du kannst es wieder deaktivieren.',
    reversibility: 'correctable',
  },
  // close-period: sign-offs and the Belege OR 958f binds.
  inventory_stocktake_approve_lines: {
    en: 'Approves the counted lines so the stocktake can be committed; nothing changes in stock yet. Until the commit, you can count those lines again.',
    'de-CH': 'Gibt die gezählten Positionen frei, damit die Inventur abgeschlossen werden kann; am Bestand ändert sich noch nichts. Bis zum Abschluss kannst du sie neu zählen.',
    reversibility: 'reversible',
  },
  // `TIME_TRANSITIONS` has no edge from approved back to submitted; only open and submitted time is editable.
  time_approve: {
    en: 'Approves the submitted time entries in your name; from then on they can be billed and no longer edited. An approval cannot be withdrawn.',
    'de-CH': 'Gibt die eingereichten Zeiteinträge in deinem Namen frei; danach sind sie verrechenbar und nicht mehr änderbar. Eine Freigabe lässt sich nicht zurücknehmen.',
    reversibility: 'final',
  },
  attach_receipt: {
    en: "Records which receipt belongs to this bill, as the voucher kept for ten years; the bill's booking does not change. If it is the wrong receipt, you attach the right one.",
    'de-CH': 'Hält fest, welcher Beleg zu dieser Rechnung gehört, als der zehn Jahre aufbewahrte Beleg; die Buchung bleibt unverändert. Ist es der falsche, hängst du den richtigen an.',
    reversibility: 'correctable',
  },
  files_new_version: {
    en: 'Adds a new version of the file that becomes the current one; the previous version stays readable and kept. A wrong version is followed by another new version.',
    'de-CH': 'Fügt eine neue Version der Datei hinzu, die zur aktuellen wird; die vorherige bleibt lesbar und aufbewahrt. Auf eine falsche Version folgt eine weitere neue.',
    reversibility: 'correctable',
  },
  // `linkFile`: the statutory retention column never goes down, and a re-link replaces only the link.
  files_link: {
    en: 'Attaches the file to the record; linked to a booked record, it must be kept for ten years and cannot be deleted before. That retention never gets shorter, not even if you link the file elsewhere.',
    'de-CH': 'Hängt die Datei an den Datensatz; an einem gebuchten Datensatz muss sie zehn Jahre aufbewahrt werden und lässt sich vorher nicht löschen. Diese Frist wird nie kürzer, auch nicht bei neuer Verknüpfung.',
    reversibility: 'final',
  },
  // go-live. `migration_declare_control_total` reopens a control until the next check.
  migration_waive_control: {
    en: 'Sets this migration check aside with your reason, which goes into the check report; it reads waived, never passed. The waiver stays on record; declaring the figure again reopens the check.',
    'de-CH': 'Stellt diese Migrationsprüfung mit deiner Begründung zurück, die in den Prüfbericht kommt; sie gilt als ausgenommen, nie als bestanden. Die Ausnahme bleibt; eine neue Vorgabe öffnet die Prüfung wieder.',
    reversibility: 'correctable',
  },
  gl_archive_import: {
    en: "Imports your old system's journal into the read-only archive; nothing is posted to your live books. Running the step again replaces its archive rows.",
    'de-CH': 'Übernimmt das Journal des alten Systems ins schreibgeschützte Archiv; in deine echten Bücher wird nichts gebucht. Ein erneuter Lauf ersetzt die Archivzeilen des Schritts.',
    reversibility: 'correctable',
  },
  // stock (D161): moved or valued, no journal entry. D02 `receiptRecord` has no reverse verb.
  receipt_record: {
    en: 'Records goods received against the purchase order and takes them into stock; the order counts them as received. This receipt has no undo; wrong stock is corrected with a stock adjustment.',
    'de-CH': 'Erfasst den Wareneingang zur Bestellung und nimmt die Ware ins Lager auf; die Bestellung zählt sie als erhalten. Rückgängig geht nicht; falschen Bestand korrigierst du mit einer Lagerkorrektur.',
    reversibility: 'final',
  },
  goods_receipt_post: {
    en: 'Completes the goods receipt: the goods enter stock and the order counts them as received; nothing goes to the ledger. Until a bill is matched to it, you can reverse it, and both stay on record.',
    'de-CH': 'Schliesst den Wareneingang ab: die Ware kommt ins Lager, die Bestellung zählt sie als erhalten; gebucht wird nichts. Bis eine Rechnung darauf abgeglichen ist, kannst du ihn zurücknehmen; beides bleibt.',
    reversibility: 'correctable',
  },
  goods_receipt_accept_lines: {
    en: "Releases the held lines into stock after their check, at the receipt's date. Until a bill is matched, you can reverse the receipt, and both stay on record.",
    'de-CH': 'Gibt die zurückgehaltenen Positionen nach der Prüfung zum Datum des Wareneingangs ins Lager frei. Bis eine Rechnung abgeglichen ist, kannst du den Eingang zurücknehmen; beides bleibt.',
    reversibility: 'correctable',
  },
  goods_receipt_reverse: {
    en: 'Reverses the goods receipt with opposite stock movements and lowers the received quantity; the original stays on record. Goods that did arrive are received again on a new goods receipt.',
    'de-CH': 'Nimmt den Wareneingang mit Gegenbewegungen im Lager zurück und senkt die erhaltene Menge; das Original bleibt erhalten. Tatsächlich gelieferte Ware erfasst du mit einem neuen Wareneingang.',
    reversibility: 'correctable',
  },
  stock_move: {
    en: 'Records a stock movement for the item; nothing is booked to the ledger. A wrong movement is corrected with an opposite one, and both stay on record.',
    'de-CH': 'Erfasst eine Lagerbewegung für den Artikel; in die Buchhaltung wird nichts gebucht. Eine falsche Bewegung korrigierst du mit einer Gegenbewegung; beide bleiben erhalten.',
    reversibility: 'correctable',
  },
  stock_run_valuation: {
    en: 'Works out the inventory value on the date and records it as a valuation run; nothing is booked to the ledger. The run stays on record for good; a new run on the same date supersedes it.',
    'de-CH': 'Ermittelt den Lagerwert per Datum und hält ihn als Bewertungslauf fest; gebucht wird nichts. Der Lauf bleibt endgültig erhalten; ein neuer Lauf am selben Datum löst ihn ab.',
    reversibility: 'final',
  },
  inventory_move: {
    en: 'Records one stock movement for the item, with its date and cost; nothing is booked to the ledger. Movements are never edited; a wrong one is corrected with another movement.',
    'de-CH': 'Erfasst eine Lagerbewegung des Artikels mit Datum und Kosten; in die Buchhaltung wird nichts gebucht. Bewegungen werden nie geändert; eine falsche korrigierst du mit einer weiteren Bewegung.',
    reversibility: 'correctable',
  },
  inventory_transfer: {
    en: 'Moves stock from one location to another as one paired movement; nothing is booked to the ledger. A wrong transfer is corrected by moving the goods back.',
    'de-CH': 'Verschiebt Bestand als ein Bewegungspaar von einem Lagerort an einen anderen; gebucht wird nichts. Eine falsche Umlagerung korrigierst du, indem du die Ware zurückverschiebst.',
    reversibility: 'correctable',
  },
  inventory_valuation_set_default: {
    en: 'Sets how stock is valued from the chosen date on, for every item without its own method; the earlier method stays on record for earlier dates. To change it, you set a method again.',
    'de-CH': 'Legt fest, wie das Lager ab dem gewählten Datum bewertet wird, für jeden Artikel ohne eigene Methode; die frühere bleibt für frühere Daten erhalten. Ändern geht mit einer neuen Festlegung.',
    reversibility: 'correctable',
  },
  inventory_valuation_set_item_method: {
    en: 'Sets how this item is valued from the chosen date on; the earlier method stays on record for earlier dates. To change it, you set a method again.',
    'de-CH': 'Legt fest, wie dieser Artikel ab dem gewählten Datum bewertet wird; die frühere Methode bleibt für frühere Daten erhalten. Ändern geht mit einer neuen Festlegung.',
    reversibility: 'correctable',
  },
  inventory_adjust: {
    en: "Adjusts the item's stock by the quantity, with your reason; nothing is booked to the ledger. A wrong adjustment is reversed with an opposite one, and both stay on record.",
    'de-CH': 'Korrigiert den Bestand des Artikels um die Menge, mit deinem Grund; gebucht wird nichts. Eine falsche Korrektur nimmst du mit einer Gegenkorrektur zurück; beide bleiben erhalten.',
    reversibility: 'correctable',
  },
  inventory_adjust_batch: {
    en: 'Adjusts stock for every line in one go, each with its reason; nothing is booked to the ledger. A wrong batch is reversed with opposite adjustments, and both stay on record.',
    'de-CH': 'Korrigiert den Bestand für jede Zeile in einem Schritt, jede mit ihrem Grund; gebucht wird nichts. Eine falsche Korrektur nimmst du mit Gegenkorrekturen zurück; beide bleiben erhalten.',
    reversibility: 'correctable',
  },
  inventory_adjust_reverse: {
    en: 'Reverses the adjustment with an opposite movement; the original stays on record. If the reversal was wrong, you adjust the stock again.',
    'de-CH': 'Nimmt die Lagerkorrektur mit einer Gegenbewegung zurück; das Original bleibt erhalten. War die Rücknahme falsch, korrigierst du den Bestand erneut.',
    reversibility: 'correctable',
  },
};

/**
 * The consequence of one verb: its own entry, else the entry of the family that governs it (`family`,
 * the dial capability the caller resolved, by name or from the call's input). `undefined` when neither
 * exists, and then no surface invents one.
 */
export function consequenceFor(verb: string, family?: string | null): Consequence | undefined {
  const own = CONSEQUENCE_FOR_VERB[verb];
  if (own !== undefined) return own;
  if (typeof family === 'string' && family.length > 0) return CONSEQUENCE_FOR_FAMILY[family];
  return undefined;
}
