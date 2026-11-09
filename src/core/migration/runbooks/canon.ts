/**
 * The W3 cutover canon, encoded as runbook items (US-G20.2 / US-G20.6). This is the PHASE4 runbook's
 * Part B turned from markdown into instantiable, owned, dated, evidenced structure.
 *
 * The canon this template encodes, point by point (spec §2 US-G20.2):
 *   - the FREEZE + DELTA discipline (declare the source freeze or a log-manually regime; migrate the
 *     delta; measure the delta-load rehearsal and keep it under the budgeted window);
 *   - TWO rehearsals, one early and one late, mirroring real staffing;
 *   - the NUMERIC go/no-go: 100% of TB lines reconciled, open items reconciled at DOCUMENT level,
 *     VAT control account equals the open return position, opening bank equals the statement closing
 *     of the day before (never a live balance);
 *   - COMMS templates for success AND delay, pre-written;
 *   - a TRAINING threshold per critical role before go-live;
 *   - ROLLBACK: the legacy system stays read-only-but-reactivatable until Stabilisierung exits, with
 *     a named trigger authority; and the SOURCE IS NEVER DESTROYED before the first successful MWST
 *     return AND the first bank reconciliation have happened in TILL;
 *   - post-go-live PROOF tasks: first invoice end to end, first payment run, first bank rec, first
 *     month-end clean.
 * The go/no-go and rollback tasks carry `undeletable: true`: waived only with a reason, never dropped.
 */

import type { RunbookTemplate } from './types.js';

/**
 * The single shipped template. One canon, not a menu of shortcuts: an operator instantiates it, then
 * edits (adds, re-dates, re-owns) the tasks per project, and may later save their own template from a
 * finished project (the G10 map-template precedent, operator-scoped, no client figures).
 */
const W3_CUTOVER: RunbookTemplate = {
  templateId: 'w3_cutover',
  label: 'Einführung nach dem W3-Ablauf',
  description:
    'Der vollständige Übernahme-Ablauf: Freeze und Delta, zwei Probeläufe, das numerische Go/No-Go, ' +
    'Kommunikation für Erfolg und Verzögerung, Schulung je kritischer Rolle, Rückfall mit benannter ' +
    'Auslöse-Befugnis, und die Nachweise nach dem Start. Das alte System bleibt lesend und reaktivierbar ' +
    'bis die Stabilisierung endet; die Quelle wird nie zerstört, bevor die erste MWST-Abrechnung und die ' +
    'erste Bankabstimmung in TILL erfolgt sind.',
  items: [
    // --- Discovery -------------------------------------------------------------------------------
    {
      itemId: 'discovery_scope',
      phase: 'discovery',
      title: 'Umfang, Stichtag und MWST-Methode festlegen',
      ownerKind: 'human',
      dueOffsetDays: -60,
      contingency: 'Bei offener Methodenwahl: Treuhänder-Freigabe (mwst_method) einholen, bevor der Stichtag steht.',
    },
    {
      itemId: 'discovery_export_list',
      phase: 'discovery',
      title: 'Exportliste anlegen (G19-Manifest)',
      ownerKind: 'agent',
      dueOffsetDays: -55,
      prerequisiteItemId: 'discovery_scope',
      evidenceKind: 'manifest',
    },

    // --- Extraction ------------------------------------------------------------------------------
    {
      itemId: 'extraction_freeze_regime',
      phase: 'extraction',
      title: 'Freeze des Quellsystems erklären oder Regime "manuell nachführen" wählen',
      ownerKind: 'human',
      dueOffsetDays: -14,
      contingency: 'Kein Freeze möglich: Delta manuell protokollieren und beim Delta-Lauf nachziehen.',
    },
    {
      itemId: 'extraction_full',
      phase: 'extraction',
      title: 'Vollständigen Export ziehen und als Beleg ablegen',
      ownerKind: 'agent',
      dueOffsetDays: -13,
      prerequisiteItemId: 'discovery_export_list',
      evidenceKind: 'fileId',
    },

    // --- Mapping ---------------------------------------------------------------------------------
    {
      itemId: 'mapping_accounts',
      phase: 'mapping',
      title: 'Konten-, Steuer- und Währungszuordnung erstellen und freigeben',
      ownerKind: 'human',
      dueOffsetDays: -12,
      prerequisiteItemId: 'extraction_full',
      evidenceKind: 'mapping_approval',
    },

    // --- Rehearsal (two rehearsals, early and late) ----------------------------------------------
    {
      itemId: 'rehearsal_early',
      phase: 'rehearsal',
      title: 'Früher Probelauf im Testmandanten mit echter Personalbesetzung',
      ownerKind: 'human',
      dueOffsetDays: -21,
      prerequisiteItemId: 'mapping_accounts',
      evidenceKind: 'check_id',
      contingency: 'Findet Fehler früh, wenn Korrektur noch billig ist.',
    },
    {
      itemId: 'rehearsal_late',
      phase: 'rehearsal',
      title: 'Später Probelauf: Delta-Lauf messen und unter dem budgetierten Fenster halten',
      ownerKind: 'human',
      dueOffsetDays: -3,
      prerequisiteItemId: 'rehearsal_early',
      evidenceKind: 'check_id',
      contingency: 'Delta-Lauf zu lang: Fenster oder Umfang anpassen, Entscheid protokollieren.',
    },
    {
      itemId: 'training_threshold',
      phase: 'rehearsal',
      title: 'Schulungsschwelle je kritischer Rolle vor dem Start erreichen',
      ownerKind: 'human',
      dueOffsetDays: -5,
      prerequisiteItemId: 'rehearsal_early',
      contingency: 'Rolle nicht geschult: Start verschieben oder Vertretung benennen.',
    },
    {
      itemId: 'comms_success_ready',
      phase: 'rehearsal',
      title: 'Kommunikation für den erfolgreichen Start vorbereiten',
      ownerKind: 'human',
      dueOffsetDays: -4,
    },
    {
      itemId: 'comms_delay_ready',
      phase: 'rehearsal',
      title: 'Kommunikation für eine Verzögerung vorbereiten',
      ownerKind: 'human',
      dueOffsetDays: -4,
      contingency: 'Vorgeschrieben, nicht optional: eine Verzögerung ohne vorbereitete Nachricht ist ein Fehler.',
    },

    // --- Cutover (the numeric go/no-go + rollback: both UNDELETABLE) ------------------------------
    {
      itemId: 'cutover_go_nogo',
      phase: 'cutover',
      title:
        'Go/No-Go: 100% der Bilanz-Zeilen abgestimmt, offene Posten auf Belegebene, MWST-Kontrollkonto ' +
        'gleich der offenen Rückgabeposition, Eröffnungsbank gleich dem Abschluss des Vortags (nie ein Live-Saldo)',
      ownerKind: 'human',
      dueOffsetDays: 0,
      prerequisiteItemId: 'rehearsal_late',
      evidenceKind: 'go_nogo',
      undeletable: true,
      contingency: 'No-Go: Verzögerungs-Kommunikation senden, Ursache protokollieren, neuen Stichtag festlegen.',
    },
    {
      itemId: 'cutover_rollback_authority',
      phase: 'cutover',
      title:
        'Rückfall festlegen: benannte Auslöse-Befugnis; altes System bleibt lesend und reaktivierbar bis die ' +
        'Stabilisierung endet',
      ownerKind: 'human',
      dueOffsetDays: 0,
      evidenceKind: 'rollback_trigger',
      undeletable: true,
      contingency: 'Wer den Rückfall auslösen darf, wird vor dem Start benannt und protokolliert.',
    },
    {
      itemId: 'cutover_conversion_signoff',
      phase: 'cutover',
      title: 'Stichtag und MWST-Periode unterschreiben (conversion_date)',
      ownerKind: 'human',
      dueOffsetDays: 0,
      prerequisiteItemId: 'cutover_go_nogo',
      evidenceKind: 'conversion_date',
    },

    // --- Live (Stabilisierung): post-go-live proof + statutory deadlines --------------------------
    {
      itemId: 'proof_first_invoice',
      phase: 'live',
      title: 'Erste Rechnung durchgängig: Nummernkontinuität, gültige QR-Referenz',
      ownerKind: 'human',
      dueOffsetDays: 3,
    },
    {
      itemId: 'proof_first_payment',
      phase: 'live',
      title: 'Erster Zahlungslauf durchgeführt',
      ownerKind: 'human',
      dueOffsetDays: 7,
    },
    {
      itemId: 'proof_first_bank_rec',
      phase: 'live',
      title: 'Erste Bankabstimmung in TILL erfolgt',
      ownerKind: 'human',
      dueOffsetDays: 14,
    },
    {
      itemId: 'proof_first_vat_return',
      phase: 'live',
      title: 'Erste MWST-Abrechnung in TILL erfolgt',
      ownerKind: 'human',
      dueOffsetDays: 45,
    },
    {
      itemId: 'proof_first_month_end',
      phase: 'live',
      title: 'Erster Monatsabschluss sauber',
      ownerKind: 'human',
      dueOffsetDays: 30,
    },
    {
      // The source may not be cancelled until the first MWST return AND the first bank rec are done.
      itemId: 'source_cancellation',
      phase: 'live',
      title:
        'Quellsystem abschalten: erst nachdem die erste MWST-Abrechnung UND die erste Bankabstimmung in TILL ' +
        'erfolgt sind; Aufbewahrungsbündel als Beleg',
      ownerKind: 'human',
      dueOffsetDays: 60,
      prerequisiteItemId: 'proof_first_vat_return',
      evidenceKind: 'source_cancellation',
      contingency: 'Reihenfolge ist Pflicht (OR 958f / GeBüV): keine Zerstörung vor den beiden Nachweisen.',
    },
    {
      itemId: 'parallel_run_close',
      phase: 'parallel_run',
      title: 'Parallellauf abschliessen: alle Vergleichszahlen geprüft und unterschrieben',
      ownerKind: 'human',
      dueOffsetDays: 90,
      evidenceKind: 'parallel_run_close',
    },

    // --- Statutory deadline tasks (dates computed by the engine, not offsets) ---------------------
    {
      itemId: 'deadline_umsatzabstimmung',
      phase: 'live',
      title: 'Umsatzabstimmung/Finalisierung: Abgleich der eingereichten Rückgaben mit dem Jahresabschluss',
      ownerKind: 'human',
      evidenceKind: 'archive_query',
      deadlineRule: 'umsatzabstimmung_180',
    },
    {
      itemId: 'deadline_berichtigung',
      phase: 'live',
      title: 'Berichtigung (Art. 72 MWSTG), falls die Umsatzabstimmung eine Differenz zeigt',
      ownerKind: 'human',
      deadlineRule: 'berichtigung_240',
    },
    {
      itemId: 'deadline_prior_year_umsatzabstimmung',
      phase: 'live',
      title: 'Vorjahres-Umsatzabstimmung aus dem G13-Archiv erstellen (Stichtag früh im Jahr)',
      ownerKind: 'human',
      evidenceKind: 'archive_query',
      deadlineRule: 'prior_year_umsatzabstimmung',
    },
  ],
};

export const RUNBOOK_TEMPLATES: readonly RunbookTemplate[] = [W3_CUTOVER];
