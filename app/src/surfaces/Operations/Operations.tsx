/**
 * The Betrieb (Operations) surface: the read-once and operational panels that used to trail the
 * company profile on `/setup`, split off onto their own route (K-16, Option A).
 *
 * WHY THE SPLIT. `/setup` had grown into one twelve-panel scroll that mixed two rhythms: the
 * first-hour profile work a person does once when a workspace is born (name, address, currency,
 * fiscal year, the workspaces list), and the standing operational panels a person visits ON PURPOSE
 * later (the offline-trust proof, the runtime line, sync and hosting, data and backup, the
 * implementation roster, diagnostics and feedback). Profil stays at `/setup`; this surface holds the
 * six operational panels, in the order they read: trust and its live runtime line first, then the
 * publish/egress posture, then the backup tool it hands off to, then the cross-client roster, then
 * the diagnostics preference last.
 *
 * This is a MOVE, not a rewrite: each panel keeps its own behaviour, its A24 padlock, its help entry
 * and its no-workspace render-away. The composition mirrors the one it left on `/setup`.
 */
import { DataBackup } from './DataBackup';
import { Diagnostics } from './Diagnostics';
import { ImplementationRoster } from './ImplementationRoster';
import { SyncHosting } from './SyncHosting';
import { SyncSignalProvider } from './sync-signal';
import { Trust } from './Trust';
import { RuntimeLine } from '../FirstRun/RuntimeLine';
import './Diagnostics.css';

export function Operations() {
  return (
    // One column, one measure, one rhythm: the operational panels sit in a single stack, the same
    // gap and measure the profile surface uses, so the two surfaces read as siblings.
    <div className="operations-stack">
      {/* M02: Trust and SyncHosting read the SAME sync contract; the provider lets a dial flip on
          SyncHosting refresh Trust's availability line live, without a reload (they stay decoupled). */}
      <SyncSignalProvider>
        {/* E07's Vertrauen panel: the offline proof, one click from the claim (spec §6, D89). It
            renders itself away with no workspace, exactly as Diagnostics does. */}
        <Trust />
        {/* M00 runtime line: mode + scheduler + last tick, read from delivery_status. Pre-workspace by
            design, so unlike Trust it stays visible before a ledger exists (spec §6, surface 2). */}
        <RuntimeLine />
        {/* M02 Sync & hosting: the publish dial and the delivery/egress posture (spec §6). It reads as
            a sibling of Trust/RuntimeLine above, and its exit box hands off to Data & Backup directly
            below, so the link is a one-scroll hop. Renders away with no workspace, like Trust. */}
        <SyncHosting />
      </SyncSignalProvider>
      {/* G04 Data & Backup: a full-workspace tool with a handful of actions (spec §6). Renders itself
          away with no workspace, like Diagnostics and Trust. */}
      <DataBackup />
      {/* G20 US-G20.4: the cross-client implementation roster, the Datenübernahme home. One row per
          mandate, composed over A23 client-side, metadata only. Renders away with no projects. */}
      <ImplementationRoster />
      <Diagnostics />
    </div>
  );
}
