/**
 * A24 §3, the CAPABILITY REGISTRY and the role defaults: the single §H-ENUM authorization enum.
 *
 * WHAT IS IN HERE, AND WHAT DELIBERATELY IS NOT. The registry ships exactly the capabilities that
 * gate a write verb that exists in `ACTIONS` today. That is not a reduction of the spec, it is the
 * spec's own rule in §6b applied to itself: "the CAPABILITY REGISTRY only grows when a new write
 * verb registers one". The authored list carried fifteen names for verbs nobody has written
 * (`dun`, `review`, `export`, `manage_plugins`, `hr.sensitive`, ...) and omitted the three the
 * engine has been asserting since Wave 0 (`manage_periods`, `unlock_period`, `diagnostics.read`).
 * A capability nothing checks is not a safety rail, it is a name in a document: it would appear in
 * the Roles tab as a checkbox that changes nothing, and the first operator to tick it would have
 * been told a lie about what their bookkeeper can do.
 *
 * The unshipped names are kept in `RESERVED_CAPABILITIES` below, so the name cannot be re-purposed
 * by a later capability that means something else by it, and so the growth path is written down
 * rather than rediscovered. A capability lands its name in `CAPABILITIES` in the same commit as the
 * verb it gates, and `src/api/registry.ts` refuses to load if a write verb has no gate at all.
 *
 * THE TWO ANCHORS ARE COMPILE-TIME CONSTANTS, NOT ROWS. `owner` resolves to `CAPABILITY_IDS` and
 * `viewer` to `VIEWER_CAPABILITIES`, both before any `role_def` query runs (see `capability.ts`).
 * Neither is ever a `role_def` row, so no migration, no `define_role` call, no future plugin and no
 * hand-edited database can shadow either one. That is the structural half of "a read-only invite is
 * genuinely read-only"; the policy half would be a row someone can change.
 *
 * This paragraph said "`viewer` to none" until 29.07.2026, and it was the LAST of three places that
 * restated the viewer bundle from memory rather than reading it. D50 gated reads and moved the
 * constant below to the five read domains; the prose here and the literal in `roles.ts` both stayed
 * behind, and the second of those is what printed "Keine Rechte" on the Roles tab for a role that
 * could read the entire ledger. Both now name the constant instead of paraphrasing it, and
 * `test/access/advertised-bundle-matches-granted.test.mjs` measures the claim rather than trusting
 * it. A comment cannot be derived, so the rule for this file is narrower: name the constant, never
 * its contents.
 */

/** One capability id. A string union, so a typo at a call site is a compile error. */
export type Capability =
  | 'read_books'
  | 'read_vat'
  | 'read_sales'
  | 'read_master_data'
  | 'read_members'
  | 'read_automations'
  | 'read_file_content'
  | 'post'
  | 'pay'
  | 'issue'
  | 'send'
  | 'dun'
  | 'manage_periods'
  | 'unlock_period'
  | 'vat_file'
  | 'manage_vat_config'
  | 'inventory.setup'
  | 'review'
  | 'export'
  | 'manage_chart'
  | 'manage_master_data'
  | 'contacts.merge'
  | 'manage_files'
  | 'manage_settings'
  | 'manage_members'
  | 'manage_custom_fields'
  | 'manage_saved_views'
  | 'manage_automations'
  // G02 plugins. Gates the plugin lifecycle writes (install/enable/disable/uninstall/compat-refresh):
  // installing third-party code that can read the books is the single most consequential admin act in
  // the product, so it is owner-only by default (no built-in bundle holds it), the narrowest-default
  // shape `manage_agent_dial` one line down also carries. Reads (list/get/preview/search) ride
  // `read_master_data` (a plugin is workspace configuration, the G05 document-template precedent), so
  // every member incl. viewer may browse the panel read-only (US-G02.1 permission-denied).
  | 'manage_plugins'
  | 'manage_agent_dial'
  | 'manage_import'
  | 'commit_migration'
  // G20 implementation projects. Gates the project/task/decision/parallel-run declaration writes and
  // all project reads beyond the roster's metadata row (spec §3). Sign-offs ride the existing
  // `commit_migration` (signing is the human half of committing). Owner-only by default (no built-in
  // bundle holds it), the `commit_migration` / `manage_import` narrowest-default shape: running a
  // client's cutover is a governing act a workspace grants deliberately through `define_role`.
  | 'manage_implementation'
  // G22 checklists (D127). Gates the five `checklist_*` writes (start, complete, skip, reopen,
  // abandon). `governance` (the G20 sibling; the registry has no operations group), and UNLIKE
  // `manage_implementation` it joins the three editable built-in bundles that hold `post`: walking a
  // MWST period is bookkeeping and moves no money. Reads ride `read_books`.
  | 'manage_checklists'
  | 'promote_workspace'
  | 'purge_archive'
  // G04 data freedom. Gates the four workspace-scoped artifact verbs (export/backup/list/delete). Its
  // sibling `manage_data_restore` stays RESERVED, because restore mints the tenant and so cannot be
  // resolved against a workspace at the boundary (spec §0a.4): the `create_workspace` shape.
  | 'manage_data_export'
  // M02 §I sync/publish contract. `manage_sync` gates the two owner publish dials
  // (sync_publish_enable/disable): turning on any egress from the local file is a workspace-owner
  // consent act, so no built-in bundle holds it by default (the `manage_plugins` narrowest-default
  // shape). `sync.read` gates the raw stream reads (sync_stream_read/artifact/status): the publish
  // stream is an INTEGRATION surface, not a reporting one, so a plain member does not see it by
  // default; the managed tier runs under a narrow role that holds exactly `sync.read`.
  | 'manage_sync'
  | 'sync.read'
  | 'tasks.read'
  | 'tasks.write'
  | 'time.read'
  | 'time.write'
  | 'time.approve'
  | 'deals.read'
  | 'deals.write'
  | 'billing.read'
  | 'billing.generate'
  // B04 retainers & mandates. The write capability for the whole mandate surface: create/update/close
  // the agreement, and generate/run-due the periodic Pauschale invoice (an A11 draft). Reads inherit
  // the `billing.read` domain (a retainer is a billing surface on the Zeit route), so this name gates
  // writes only, the `billing.generate` shape one register over.
  | 'retainer.manage'
  // B03 job costing. `costing.read` is the profitability read domain (the `billing.read` shape:
  // ABSENT from `READ_CAPABILITIES` so `viewer` never picks it up). Deliberately SEPARATE from
  // B00's membership-gated project reads: the cost basis is where employee pay-rate data will
  // surface once the OP1 cost-rate column lands, so the gate is a revDSG data-minimization
  // control, not a convenience split (spec B03 §3).
  | 'costing.read'
  // I03 landed cost. The write capability for the landed-cost surface (voucher create, allocate
  // confirm, reverse): capitalising freight/duty/handling onto inventory posts a balanced A02 entry
  // and moves the balance-sheet figure, so choosing what enters acquisition cost (OR 960) is a
  // money-path judgment. Reads inherit `read_master_data` (the allocator is a pure calculation over a
  // voucher), so no `landed_cost.read` name is minted. Held by G / T / A per the spec's §3 personas.
  | 'procurement.landed_cost'
  // E02 HR-lite. `hr.read` is the personnel read domain (the `tasks.read`/`time.read` shape:
  // operational + health-adjacent, ABSENT from `READ_CAPABILITIES` so `viewer` never picks it up).
  // `hr.manage` gates the roster/absence writes; `hr.sensitive` gates the AHV number specifically;
  // `spesen.submit` drafts a claim; `spesen.approve` is the four-eyes approval/reject gate.
  | 'hr.read'
  | 'hr.manage'
  | 'hr.sensitive'
  | 'spesen.submit'
  | 'spesen.approve'
  // E01 e-signature. `sign.write` gates the sign-request lifecycle (create, record events,
  // complete, withdraw, discard); `sign.send` additionally gates the ONE outbound verb
  // (`sign_requests_send`, the ALL-OF shape), split exactly as A11 splits `issue` from `send`:
  // preparing a request across client workspaces (a Treuhänder under A23) is not the mandate to
  // transmit it. Reads inherit the `read_master_data` domain (a sign request annotates a filing,
  // the E00 list reasoning), so no `sign.read` name is minted.
  | 'sign.write'
  | 'sign.send'
  // F02 customer portal. `portal.manage` gates the grant lifecycle writes (create, send, revoke): a
  // grant exposes a customer's own invoices/quotes/documents outside the device under a scoped,
  // expiring token, so minting or revoking one is a governing act over the customer relationship.
  // The LIST read takes `read_master_data` (the Portal-Zugang panel lives on the C00 contact detail,
  // so seeing a customer's grants is part of seeing the customer), which is also the read twin a
  // custom field on a `portal_grant` inherits. No separate `portal.read`/`portal.send` name is
  // minted: the OSS core wires no transport, so `portal_grant_send`'s outbound half is the same P8
  // confirm gate every OP4 verb carries, not a second capability.
  | 'portal.manage'
  // F01 report builder. `reports.read` is the analytics read domain (the `tasks.read`/`billing.read`
  // shape: operational, ABSENT from `READ_CAPABILITIES` so `viewer` never picks it up) covering the
  // metadata reads (list/sources/runs). `reports.write` gates building/editing/scheduling a report;
  // `reports.run` gates producing an artifact. run is split from write on purpose (US-F01.4): a role
  // may run existing reports without being able to build new ones. `reports_preview`/`reports_run`
  // additionally assert the composed SOURCE's own read gates in-engine, so a report never reads past
  // the caller's RBAC.
  | 'reports.read'
  | 'reports.write'
  | 'reports.run'
  // E04 local mail store. `mail.read` is the correspondence read domain (the `hr.read` shape:
  // Art. 321 material, ABSENT from `READ_CAPABILITIES` so `viewer` never picks it up) and, per the
  // spec's own US-E04.2, ALSO gates `mail_reindex`: the index is derived, so re-deriving it is the
  // read act repeated, not a new disclosure. `mail.write` gates connecting a store and writing a
  // draft back into the client's Drafts folder.
  | 'mail.read'
  | 'mail.write'
  // E05 voice profile + local runtime. `voice.read` is the voice read domain (the `mail.read`
  // shape, and for the same Art. 321 reason: a profile is DERIVED from confidential
  // correspondence, and `voice_retrieve` hands back exemplar BODIES read from that mail, so the
  // read is exactly as sensitive as `mail_thread_get`). `voice.write` gates learning a profile
  // over that corpus and choosing which local model runs (`runtime_select`): both govern how
  // drafts are produced, which is what the human must stay in front of (P8's spirit).
  | 'voice.read'
  | 'voice.write'
  // E06 ledger-grounded drafts. `draft.write` gates generating and regenerating a draft reply: one
  // act that reads the thread (mail), the voice exemplars, and (for a consented contact holding
  // `read_sales` in the SAME actor) the books, and writes into the practitioner's own Drafts
  // folder. A single-capability gate, the `billing.generate` shape: the composed act is the unit a
  // role is granted, and the ledger half is additionally asserted in-engine (`read_sales`) so a
  // holder of `draft.write` alone can never launder figures into a prompt. Reads (`draft_list`)
  // ride `mail.read`: a draft run is correspondence metadata, and no `draft.read` name is minted
  // (the sign-reads precedent).
  | 'draft.write'
  // E07 the offline proof. `egress.read` gates the trust indicator (`egress_status`) and the offline
  // self-test (`egress_self_test`). It is the ONE read domain with no write producing its data: the
  // socket count it returns is OBSERVED at read time and never stored (spec §4). It is nonetheless a
  // read domain rather than a bundle-named grant, because a trust indicator must be visible to
  // EVERYONE who can see anything (persona F/G/A, including a read-only viewer), and it discloses no
  // tenant data at all: only whether THIS process dialled out. A non-member holds nothing and gets
  // the padlock (US-E07.1 permission-denied). Both verbs are deliberately readable by an agent
  // auditing the claim (spec §5).
  | 'egress.read'
  // G05 document templates. Gates the template lifecycle writes (create/update/set-default/
  // archive): a template is the workspace's outward face, and changing what every future invoice
  // looks like is a governing act, the `manage_custom_fields` shape exactly (owner-only by
  // default, granted via `define_role`). Reads ride `read_master_data` (the D50 domain rule: a
  // template is workspace configuration, the `manage_settings -> read_master_data` twin), so
  // list/get/preview stay open to every member incl. `viewer`, which is what spec §2's
  // "read/preview stays open to any workspace member" asked for.
  | 'manage_document_templates'
  // G05 §10 dispatch texts. Gates `dispatch_text_upsert` (the workspace's saved outbound message
  // text per document kind and locale): reshaping the voice every future invoice/quote/reminder
  // mail carries is a governing act over the workspace's outward face, the
  // `manage_document_templates` shape exactly. Reads (`dispatch_preview`, `list_dispatches`) ride
  // `read_master_data`, so the Protokoll and the preview stay open to every member incl. `viewer`
  // (spec §10.3 "log and preview stay readable to any workspace member").
  | 'manage_dispatch_texts'
  // I04 three-way match. `purchasing.match` gates recording a match (the create verb): checking a
  // vendor bill against its order and physical receipt and clearing it for payment is a money-path
  // control, the `inventory.setup` register. `purchasing.match_override` is the stronger money-authority
  // right, gating the forced override of an out-of-tolerance match AND the reverse of a permanent
  // record (an override is a judgment on Vorsteuer-bearing goods, the D02 `match_bill`-rides-`post`
  // reasoning made explicit). Reads (evaluate/get/list/exceptions/status) ride `read_master_data`, the
  // D02 purchasing read domain, so every member incl. `viewer` may see a match and its exceptions.
  | 'purchasing.match'
  | 'purchasing.match_override'
  // N00 environment landscape (D126). `landscape.manage` (`governance`, NOT in any built-in bundle:
  // creating, resetting, deleting or switching an environment is a host-level governing act the owner
  // holds via CAPABILITY_IDS and grants deliberately through `define_role`, the `manage_sync`
  // narrowest-default shape). `landscape.read` (`reading`, and IN READ_CAPABILITIES, the `egress.read`
  // shape: the environment indicator and the LIVE banner (E6a) must be visible to everyone, a viewer
  // included, and it discloses only machine topology) gates the list/status/current reads. The raw and
  // secret-retaining copy overrides (Phase B) sit on top of `landscape.manage` as owner-only sub-gates,
  // so that name is the floor, never the whole story.
  | 'landscape.read'
  | 'landscape.manage'
  // The Phase B owner-only sub-gate (D-ENV-5). A copy always neutralizes live access secrets; RETAINING
  // them (a full-fidelity debug clone that can still touch a real bank) is an owner-only act, so this
  // sits ON TOP of `landscape.manage`: NOT in any built-in bundle, owner holds it via CAPABILITY_IDS,
  // and `env_copy retainSecrets=true` resolves here instead of `landscape.manage` (actionCapabilities.ts).
  | 'landscape.retain_secrets'
  | 'diagnostics.read';

/** How the Roles tab groups the checkboxes. Presentation only: it grants nothing. */
export type CapabilityGroup = 'reading' | 'money' | 'compliance' | 'governance';

/**
 * THE READ CAPABILITIES, ONE PER DOMAIN (D50, owner-decided 29.07.2026).
 *
 * A24 shipped gating WRITES only, and the registry boundary returned early for every read. The wave
 * critic measured what that meant: a NON-MEMBER of a provisioned workspace called `list_journal`,
 * `get_audit_log`, `trial_balance`, `vat_config`, `list_members` and `export_statement` and every
 * one answered `ok`, including a full CSV export of the ledger. `revoke_member` promises in its own
 * summary to "remove a member's access to this workspace" and removed only the writes.
 *
 * A single flat `read` and reusing the WRITE capability were both offered to the owner and declined,
 * for the same reason: the role most Swiss businesses actually want is a Treuhänder who sees the
 * books and not the member list, and neither alternative can express it. `read` cannot separate the
 * two, and reusing the write capability would mean a Treuhänder had to be able to POST in order to
 * be able to LOOK.
 *
 * THE CUT IS BY DOMAIN, and the rule that decides which domain a verb belongs to is written here
 * rather than left to be inferred, because 74 of 90 specs will extend this list and they need the
 * rule and not the table: A READ BELONGS TO THE DOMAIN WHOSE WRITES PRODUCE THE DATA IT RETURNS,
 * and A PREVIEW INHERITS THE DOMAIN OF THE WRITE IT PREVIEWS. So `preview_bank_opening_balance` is
 * `read_books` (it previews a journal entry) rather than `read_master_data` (it names a bank
 * account), `vat_preview` is `read_vat`, and `preview_feedback` is ungated because
 * `prepare_feedback` is. A capability that adds a verb applies the rule; it only adds a NAME here
 * when it brings a domain that does not exist yet, which is the same discipline §6b already imposes
 * on the write side.
 *
 * `read_automations` IS THE FIRST NAME ADDED BY THAT LAST CLAUSE, and it is worth recording why it
 * was a new domain rather than a home in one of the five. G01's four reads return `automation_rule`
 * and `automation_run` rows. The writes that produce them are G01's own (`create_automation_rule`
 * and its siblings, and the fire path behind `run_due_automations`), and no other domain's writes
 * produce them at all: an automation rule is not the ledger, not a register beside it, not a
 * document and not a membership. The rule places them in G01's domain, and G01's domain did not
 * exist, so the name lands here.
 *
 * REUSING `manage_automations` FOR THE READS WAS THE OBVIOUS SHORTCUT AND IT IS UNSAFE, which is
 * D50's own reasoning arriving at a sharper case than the one it was decided on. D50 declined
 * reusing the write capability because a Treuhänder should not have to POST in order to LOOK. Here
 * the cost is not a role that is merely awkward, it is a safety property that silently stops
 * working: `disable_automation_rule` is deliberately UNGATED, because "a stop button that requires
 * a permission is not a stop button" (G01 §4), and stopping a rule requires its `ruleId`, which is
 * only obtainable from `list_automation_rules`. Gating that read on `manage_automations` would put
 * the stop button behind the administrator capability it was explicitly designed to work without,
 * and nothing anywhere would say so.
 */
export const READ_CAPABILITIES: readonly Capability[] = [
  'read_books',
  'read_vat',
  'read_sales',
  'read_master_data',
  'read_members',
  'read_automations',
  // E07, and the second entry here (with `read_automations`) added for a REASON rather than because
  // it maps to a write producer: the trust indicator must be visible to everyone who can see
  // anything, a read-only viewer included, because the whole point of OP6 is a claim the practitioner
  // can watch on an ordinary Tuesday. It is safe to put in the viewer anchor precisely because it
  // discloses no tenant data: it reports only whether the TILL PROCESS opened a socket, which is not
  // a secret about the books, the mail, or the members. `read_members` is still the one read a viewer
  // is denied; `egress.read` is the one read nobody should be.
  'egress.read',
  // N00, and the third entry here added for a REASON rather than a write producer (the `egress.read`
  // shape): the environment indicator, and above all the LIVE banner (matrix E6a), must be visible to
  // EVERYONE who can see anything, a read-only viewer included, because knowing you are on the live
  // books is a safety fact, not a privilege. It is safe in the viewer anchor because it discloses only
  // machine topology (the environments and their paths), never a client's financial data.
  'landscape.read',
];

/**
 * The registry, in the order the Roles tab renders it.
 *
 * Reading first, because it is the first question an operator answers about a role and because a
 * role that can see nothing can do nothing useful with any write below it. Money next, because it
 * is what most people opened the screen to decide.
 */
export const CAPABILITIES: readonly { id: Capability; group: CapabilityGroup }[] = [
  { id: 'read_books', group: 'reading' },
  { id: 'read_vat', group: 'reading' },
  { id: 'read_sales', group: 'reading' },
  { id: 'read_master_data', group: 'reading' },
  { id: 'read_members', group: 'reading' },
  // G01, and the read half of the pair whose write half is `manage_automations` below. It is a
  // separate name from that one on purpose: seeing what the unattended subsystem is configured to do
  // is not the same act as deciding it, and G01's ungated stop button is unusable without the read.
  { id: 'read_automations', group: 'reading' },
  // E00, and the one entry in this group that is NOT a read DOMAIN, which is the whole reason it is
  // here. `read_master_data` covers the file LIST: a role may see that a voucher exists, what it is
  // called, when it was filed and how long it must be kept. This one covers the BYTES, and the two are
  // not the same disclosure: the owner's answer to the critic on 30.07.2026 was that a read-only invite
  // may see the filing and may not download it, reproduced end to end with an AHV number inside a
  // payload `viewer` could fetch. It is therefore deliberately absent from `READ_CAPABILITIES` (that
  // list is the per-domain cut, and `viewer` resolves to it), and named explicitly in the three
  // built-in bundles that need it.
  //
  // NOT PER-FILE CLASSIFICATION. The owner explicitly declined that: `hr.sensitive` stays reserved for
  // E02 / A34, and E00's spec §0 records it as a named follow-up rather than a thing E00 built.
  { id: 'read_file_content', group: 'reading' },
  // E03, and the `read_file_content` shape rather than a D50 domain: it lives in the `reading`
  // group, is deliberately ABSENT from `READ_CAPABILITIES` (so the viewer anchor does not pick it
  // up), and is named explicitly in the three editable built-in bundles below. A read-only invite
  // looks at the BOOKS; the operational to-do queue (who is chasing whom by when) is workwork, not
  // books, and a viewer who should see it gets a custom role, the expressiveness D50 paid for.
  { id: 'tasks.read', group: 'reading' },
  // B01, the `tasks.read` shape one register over: it lives in the `reading` group, is deliberately
  // ABSENT from `READ_CAPABILITIES` (so the viewer anchor does not pick it up), and is named
  // explicitly in the three editable built-in bundles below. A read-only invite looks at the BOOKS;
  // who worked which hours on which client is operational workwork (and, under ArG Art. 46, a
  // personnel record), not books, and a viewer who should see it gets a custom role, the
  // expressiveness D50 paid for.
  { id: 'time.read', group: 'reading' },
  // C01, the E03 shape one register over: `reading` group, deliberately ABSENT from
  // `READ_CAPABILITIES` (so the viewer anchor does not pick it up), named explicitly in the
  // bundles that hold it. A read-only invite looks at the BOOKS; the sales funnel (who is being
  // courted for how much, and why a deal was lost) is relationship work, not books, and a viewer
  // who should see it gets a custom role, the expressiveness D50 paid for.
  { id: 'deals.read', group: 'reading' },
  // B02, the `time.read`/`deals.read` shape one register over: `reading` group, deliberately ABSENT
  // from `READ_CAPABILITIES` (so the viewer anchor does not pick it up), named explicitly in the
  // three editable built-in bundles below. A read-only invite looks at the BOOKS; the unbilled pile
  // and the WIP figure are operational billing tooling (who is ready to invoice, what is earned but
  // not yet billed), not books, and a viewer who should see them gets a custom role.
  { id: 'billing.read', group: 'reading' },
  // B03, the `billing.read` shape one register over: `reading` group, deliberately ABSENT from
  // `READ_CAPABILITIES` (so the viewer anchor cannot pick it up), named explicitly in the three
  // editable built-in bundles below. A read-only invite looks at the BOOKS; project profitability
  // is management reporting whose cost basis will carry employee pay-rate data (revDSG), and a
  // viewer who should see it gets a custom role, the expressiveness D50 paid for.
  { id: 'costing.read', group: 'reading' },
  // E02, the `tasks.read`/`time.read`/`deals.read` shape one register over: `reading` group,
  // deliberately ABSENT from `READ_CAPABILITIES` (so the viewer anchor cannot pick it up), named in
  // the three editable built-in bundles below. A read-only invite looks at the BOOKS; personnel
  // records, sick-leave (health data, revDSG Art. 5 lit. c Ziff. 2) and Spesen line detail are
  // heightened-sensitivity operational data, and the self-scoping filter (`hr_absence_list` /
  // `expense_claim_list`) narrows even a holder to their own rows unless they also hold `hr.manage`
  // or `spesen.approve`.
  { id: 'hr.read', group: 'reading' },
  // F01, the `billing.read`/`costing.read` shape one register over: `reading` group, deliberately
  // ABSENT from `READ_CAPABILITIES` (so the viewer anchor cannot pick it up), named explicitly in the
  // three editable built-in bundles below. A read-only invite looks at the BOOKS; a workspace's own
  // saved analytics reports and their run history are operational tooling, and a viewer who should see
  // them gets a custom role, the expressiveness D50 paid for.
  { id: 'reports.read', group: 'reading' },
  // E04, the strictest entry in this group: the mail index is Art. 321 correspondence, so
  // `mail.read` is deliberately ABSENT from `READ_CAPABILITIES` (the viewer anchor can never pick
  // it up) and joins NO editable built-in bundle except `agent` below, the persona the
  // local-correspondence cluster centres. A bookkeeper or Treuhänder who should read a client's
  // confidential mail gets that said deliberately through `define_role`, never by default.
  { id: 'mail.read', group: 'reading' },
  // E05, the E04 reasoning verbatim one register over: retrieval reads exemplar bodies out of the
  // Art. 321 corpus, so `voice.read` is ABSENT from `READ_CAPABILITIES` (the viewer anchor can
  // never pick it up) and joins NO editable built-in bundle except `agent` below.
  { id: 'voice.read', group: 'reading' },
  // E07, the offline proof. Last in the `reading` group because it is the one read that is not a
  // business-data domain at all: it is the trust surface, held by every member including `viewer`
  // (it is in `READ_CAPABILITIES` and `BUILT_IN_READS`), because a claim the user is meant to watch
  // must be visible from every role, and it leaks no tenant data to be so.
  { id: 'egress.read', group: 'reading' },
  { id: 'post', group: 'money' },
  { id: 'pay', group: 'money' },
  { id: 'issue', group: 'money' },
  { id: 'send', group: 'money' },
  // E01's outbound half, beside the `send` whose reasoning it mirrors: transmitting a signature
  // request to a provider is an outbound, irreversible disclosure (revDSG: signer data leaves the
  // device), so it is granted separately from `sign.write` exactly as `send` is from `issue`. Not
  // literally money, but this row of the picker IS the outbound-act row, and moving the checkbox
  // to a new group is a change nobody asked for (the D62 argument).
  { id: 'sign.send', group: 'money' },
  // A15, arriving from RESERVED_CAPABILITIES by the standing route: the name lands here in the
  // commit that registers the verbs it gates (the reserved row's owner label read "A18 dunning";
  // dunning is A15, A18 is creditor payments, so the label was corrected on the way out). `money`
  // because dunning is the chase half of the receivable: proposing is harmless, but the capability
  // also opens issuing, and an issued run can book a Mahngebühr into 1100.
  { id: 'dun', group: 'money' },
  // B02's write half: turning approved time into an A11 invoice draft (and releasing a cancelled
  // draft's time). `money`, beside `issue`/`send` whose sales surface it extends: generating a draft
  // invoice is the same class of act as `issue`, and B02 stops at a draft (P8) exactly as issuing a
  // document does before `send`. Held by `bookkeeper` and `agent` (the sales surface), NOT
  // `treuhaender`, which excludes the day-to-day sales surface (the `deals`/`issue` boundary).
  { id: 'billing.generate', group: 'money' },
  // B04, beside `billing.generate` whose sales surface it extends: generating a retainer's periodic
  // invoice is the same class of act (an A11 draft, P8), and creating/closing the mandate is the
  // configuration around it. `money`, held by `bookkeeper`, `agent` AND `treuhaender`: unlike the
  // day-to-day `billing.generate` sales surface, a mandate IS the Treuhänder revenue model the spec
  // centres, so this one capability joins that mandate too.
  { id: 'retainer.manage', group: 'money' },
  // I03 landed cost, `money` beside the other posting acts (`post`/`issue`/`billing.generate`):
  // confirming an allocation posts a balanced A02 entry (Dr inventory control, Cr clearing) and lifts
  // the inventory figure on the balance sheet, so it is the same class of act. Held by `bookkeeper`,
  // `treuhaender` AND `agent`: the spec's §3 gives G the period-end capitalisation, T the fiduciary
  // answerability for the Bilanz, and A full MCP parity (it drafts and may execute when policy
  // permits). `owner` holds it through CAPABILITY_IDS as it holds everything.
  { id: 'procurement.landed_cost', group: 'money' },
  { id: 'manage_periods', group: 'compliance' },
  { id: 'unlock_period', group: 'compliance' },
  { id: 'vat_file', group: 'compliance' },
  { id: 'manage_vat_config', group: 'compliance' },
  // J03, owner-decided 2026-08-11 after the valuation critic. The three valuation-policy writes
  // (enable a method, set the workspace default, override one item) were shipped on
  // `manage_master_data` because the A24 register had no better name, and the owner rejected that:
  // choosing weighted average over FIFO decides the inventory figure on the BALANCE SHEET, and
  // `manage_master_data` is the right that also covers renaming an item.
  //
  // `compliance` rather than `governance`, beside `manage_vat_config` whose shape it copies exactly:
  // both configure the BASIS of a statutory figure without producing the figure. It is not `post`,
  // because J03 posts nothing at all: the number reaches the books through J06.
  //
  // The tension the owner was resolving is that `treuhaender` deliberately does NOT hold
  // `manage_master_data` (the fiduciary keeps the books without owning the master data), while
  // `bookkeeper` does. Under the old gate the mandate answerable for the Bilanz could not choose the
  // valuation basis and the day-to-day bookkeeper could. Both built-ins hold this one, for the two
  // reasons the spec's §3 personas give: G (the GmbH bookkeeper) runs the period end, and T (the
  // Treuhänder) is answerable for Stetigkeit under OR 958c. `agent` does NOT: the spec's A persona
  // supplies market prices and projects what-ifs, which are READS, and an unattended policy change is
  // the one thing the force-plus-reason guard on both dated writes exists to make impossible to do
  // quietly. `owner` holds it through CAPABILITY_IDS as it holds everything.
  { id: 'inventory.setup', group: 'compliance' },
  // A25, both arriving from RESERVED_CAPABILITIES by the standing route: the name lands here in the
  // commit that registers the verbs it gates. `compliance` because both are the fiduciary's half of
  // the close: `review` is the sign-off workflow that precedes the A03 lock (comment/flag/approve on
  // entries, metadata only, never a posting), and `export` is what puts the books, statements and
  // MWST figures into a file someone outside the workspace will rely on, the same family as
  // `vat_file` one line up. Neither is a read domain: `review_status` reads on `read_books`, and the
  // export verbs take `export` in the ALL-OF form BESIDE the domain read they reproduce.
  { id: 'review', group: 'compliance' },
  { id: 'export', group: 'compliance' },
  // B01's sign-off, and a THIRD time name rather than a bundle with `time.write`, because approving
  // is the one act self-review taints: an approval by whoever logged the hours is not an approval
  // (the A25 `review` reasoning applied to time). `compliance` because approve/lock is the gate
  // that turns captured hours into the frozen ArG working-time record B02 bills from; among the
  // built-ins only `treuhaender` holds it (and `owner` through the anchor).
  { id: 'time.approve', group: 'compliance' },
  // E02, the four-eyes approval gate, `compliance` beside `time.approve`/`review` whose reasoning it
  // borrows whole: approving a claim POSTS its reimbursement liability and queues the payment, and
  // approving your OWN claim is refused regardless of rights (`self_approval`), so sign-off is the
  // one act self-review taints. It also gates `expense_claim_reject` (approve and reject share the
  // review right). Owner-only by default (granted deliberately through `define_role`, the
  // `manage_automations` posture): the four-eyes control is a policy a workspace configures, and
  // the persona the spec centres for it is the Treuhänder.
  { id: 'spesen.approve', group: 'compliance' },
  { id: 'manage_chart', group: 'governance' },
  { id: 'manage_master_data', group: 'governance' },
  // C00's elevated right, split out of `manage_master_data` by the F5 retrofit (30.07.2026,
  // docs/planning/f5-retrofit-survey.md). The spec named `contacts.merge` from the start and the map's
  // own comment carried the deferral ("a finer split is a future A24 retrofit"). It gates
  // `contacts_merge` and `contacts_anonymise` in the ALL-OF form beside `manage_master_data`, the
  // `record_payment` shape: a merge IS a master-data edit AND an elevated, destructive-adjacent act
  // (a one-way tombstone; a revDSG erasure). Beside the capability it was split out of, same group,
  // because moving where the checkbox renders is a change nobody asked for (the D62 argument).
  { id: 'contacts.merge', group: 'governance' },
  // E00's filing act, and it is a separate NAME from `manage_master_data` rather than a separate
  // category: same group, beside the capability it was split out of, because moving where the checkbox
  // renders is a change nobody asked for. WHY it had to be split is the F8 finding. E00's verbs were all
  // `manage_master_data`, which `treuhaender` deliberately does not hold, so the fiduciary who keeps the
  // books could POST an entry and could not attach its Buchungsbeleg. Widening `manage_master_data` to
  // fix that would have handed the Treuhänder the contacts, items and bank-account registers with it,
  // which is the mandate boundary D50 was decided on.
  { id: 'manage_files', group: 'governance' },
  // E03's write half, beside the master-data family it most resembles: creating, rescheduling,
  // snoozing, completing and cancelling to-dos is operational data entry over the `task` register,
  // not money (no task ever posts) and not compliance. Its own NAME rather than a ride on
  // `manage_master_data`, because a Treuhänder or a narrow custom role that must chase follow-ups
  // should not need the contacts/items/bank registers to do it (the F8 `manage_files` argument, one
  // register over). `tasks_complete` additionally allows the ASSIGNEE without this capability,
  // asserted in-engine (`completeTask`), the `unlock_period` state-dependent shape.
  { id: 'tasks.write', group: 'governance' },
  // E01's write half, beside `manage_files` whose reasoning it borrows: requesting, tracking and
  // completing signatures is operational work over the filing register, not money (no sign verb
  // ever posts) and not compliance. Its own NAME rather than a ride on `manage_files`, because a
  // role that chases signatures should not need version/retention/delete power over every file to
  // do it. The outbound half is `sign.send`, in the money group beside `send` (below).
  { id: 'sign.write', group: 'governance' },
  // B01's write half, the `tasks.write` reasoning one register over: capturing, editing and
  // submitting hours is operational data entry over the `time_entry` register, not money (no time
  // verb ever posts; B02 bills) and not compliance. Its own NAME rather than a ride on
  // `manage_master_data`, because a freelancer's agent that logs time should not need the
  // contacts/items/bank registers to do it.
  { id: 'time.write', group: 'governance' },
  // C01's write half, beside `tasks.write` whose reasoning it borrows whole: creating, moving,
  // marking and annotating deals is operational data entry over the `deal`/`pipeline` registers,
  // not money (a deal never posts; its value is an estimate) and not compliance. Its own NAME
  // rather than a ride on `manage_master_data`, because a sales role that works the funnel should
  // not need the chart-adjacent registers to do it. `deals_to_quote` additionally re-checks the
  // quote verb's own gate through the dispatch, so this name alone never mints a document.
  { id: 'deals.write', group: 'governance' },
  // F02, the `deals.write`/`sign.write` shape one register over: minting a scoped, expiring portal
  // grant for a customer is operational work over the customer relationship, `governance` beside the
  // master-data family it most resembles. Its own NAME rather than a ride on `manage_master_data`,
  // because a sales role that opens portal access should not need the chart-adjacent registers to do
  // it, and because a grant is a heightened, revDSG-relevant disclosure act a custom role may want to
  // hold WITHOUT the rest of master data. Held by `bookkeeper` and `agent` (the sales surface), NOT
  // `treuhaender` (the D50 `deals`/`billing.generate` boundary: the day-to-day sales surface).
  { id: 'portal.manage', group: 'governance' },
  { id: 'manage_settings', group: 'governance' },
  { id: 'manage_members', group: 'governance' },
  // E02, both arriving from RESERVED_CAPABILITIES in the same commit that registers the verbs they
  // gate (the standing route). `governance`: maintaining the personnel roster and, more strictly,
  // the AHV number is administration of what the workspace records about people, not day-to-day data
  // entry. `spesen.submit` is the claim-drafting write, `governance` beside the `tasks.write`/
  // `time.write` operational writes it resembles. All three are owner-only by default and granted
  // through `define_role`: personnel data and its AHV number are the least-defaulted surface in the
  // product, and a workspace decides deliberately who maintains them.
  { id: 'hr.manage', group: 'governance' },
  { id: 'hr.sensitive', group: 'governance' },
  { id: 'spesen.submit', group: 'governance' },
  // G00. Both arrive here from RESERVED_CAPABILITIES in the same commit that registers the verbs they
  // gate, which is the rule this file states about itself. `governance` and not a fourth group:
  // defining a custom field reshapes what the workspace records, and publishing a shared view puts a
  // filter on everyone's screen. Both are administration, neither is data entry.
  // E04's write half, beside the operational writes it resembles in shape and NOT in sensitivity:
  // connecting a mail store points TILL at professional-secrecy material, and writing a draft puts
  // words into the practitioner's own Drafts folder under their address. Held by `agent` only among
  // the built-ins (the cluster's whole point is the local agent drafting replies); everyone else is
  // a `define_role` decision.
  { id: 'mail.write', group: 'governance' },
  // E05's write half, beside E04's: learning a voice points the local model at professional-secrecy
  // material, and selecting the model changes how every draft is produced. Held by `agent` only
  // among the built-ins; everyone else is a `define_role` decision.
  { id: 'voice.write', group: 'governance' },
  // E06's write half, beside the two it composes: generating a draft reads Art. 321 material and
  // puts words under the practitioner's own address into their Drafts folder. Held by `agent` only
  // among the built-ins (the cluster's whole point is the local agent drafting replies); everyone
  // else is a `define_role` decision.
  { id: 'draft.write', group: 'governance' },
  { id: 'manage_custom_fields', group: 'governance' },
  { id: 'manage_saved_views', group: 'governance' },
  // G05, beside the two G00 names whose shape it takes: a document template governs what every
  // future invoice/quote/credit-note/dunning letter LOOKS like, workspace-wide. Owner-only by
  // default (no built-in bundle holds it), exactly like `manage_custom_fields`: branding the
  // workspace's outward face is a `define_role` decision, not a bookkeeping default. Reads ride
  // `read_master_data`, so every member can list and preview.
  { id: 'manage_document_templates', group: 'governance' },
  // G05 §10, beside the template capability whose shape it takes: the saved dispatch text is the
  // workspace's outbound VOICE the way the template is its outbound LOOK. Owner-only by default
  // (no built-in bundle holds it); reads ride `read_master_data`.
  { id: 'manage_dispatch_texts', group: 'governance' },
  // F01, beside `manage_saved_views` whose analytics-configuration reasoning they extend: building or
  // editing a saved report (reports.write) and producing its artifact (reports.run) are configuration
  // and operation over the workspace's own reporting, not money (a report posts nothing, P3) and not a
  // read domain (that is reports.read above). `governance` and grouped here so the three F01 checkboxes
  // read together; the run/write split lets a role run existing reports without building new ones.
  { id: 'reports.write', group: 'governance' },
  { id: 'reports.run', group: 'governance' },
  // G01, arriving from RESERVED_CAPABILITIES by the same route G00's two took: the name lands here in
  // the commit that registers the verbs it gates. `governance` rather than `money`, although an
  // automation can cause a posting: what this capability grants is the power to decide what the
  // ledger does unattended, which is a governing act. The verb it eventually calls is still gated by
  // its own money capability at the moment it fires, against the rule's author.
  { id: 'manage_automations', group: 'governance' },
  // G02, arriving from RESERVED_CAPABILITIES by the standing route: the name lands here in the commit
  // that registers the verbs it gates (`install_plugin`/`enable_plugin`/`disable_plugin`/
  // `uninstall_plugin`/`refresh_plugin_compat`). `governance` and NOT in any built-in bundle: running
  // third-party code that reaches the ledger through the agent transport is a governing act a
  // workspace grants deliberately through `define_role`, the `manage_agent_dial` narrowest-default
  // shape below (owner holds it via CAPABILITY_IDS). Reads ride `read_master_data` (the D50 domain
  // rule: a plugin is workspace configuration, the `manage_document_templates -> read_master_data`
  // twin), so list/get/preview/search stay open to every member incl. `viewer`.
  { id: 'manage_plugins', group: 'governance' },
  // A26, arriving from RESERVED_CAPABILITIES by the standing route: the name lands here in the commit
  // that registers the verbs it gates (`set_agent_dial`, `approve_drafted_action`,
  // `reject_drafted_action`). `governance` and NOT held by any built-in bundle: the dial is the
  // safety rail that decides what the agent may auto-execute, and approving a drafted action is a
  // second-actor oversight act, so both are granted deliberately through `define_role`, owner-only by
  // default (US-A26.8, §3). Deliberately not `money` even though the dial governs posting: what this
  // capability grants is the power to DECIDE what runs unattended, which is governing, and the verb it
  // eventually approves is still gated by its own money capability against the approver at run time.
  { id: 'manage_agent_dial', group: 'governance' },
  // G10 migration maps, arriving from RESERVED_CAPABILITIES by the standing route: the name lands
  // here in the commit that registers the verbs it gates (the G10 map verbs; G09's plan machine
  // consumes it next wave, and the reserved row's owner label read "G03 onboarding import", whose
  // three column-mapping verbs moved to G10 under D86). `governance` and not `money`: a migration
  // map decides how a foreign chart and tax world land in THIS workspace's books, which is the
  // same class of act as `manage_chart`, and the maps it writes drive later posting through verbs
  // that still carry their own money capabilities at commit time. NOT in any built-in bundle:
  // `owner` holds it through CAPABILITY_IDS, and widening `bookkeeper`/`treuhaender` is a policy
  // decision G09 puts to the owner with the plan machine, not something the map layer decides in
  // passing.
  { id: 'manage_import', group: 'governance' },
  // G09, the migration harness's SECOND capability, distinct from `manage_import` on purpose (spec §3,
  // mirroring G04's manage_data_export / manage_data_restore split). `manage_import` gates discovery
  // through checking freely, so an agent can reach a clean Eröffnungsprüfung unattended; this one is
  // the strong gate the engine checks on a MONEY-PATH commit and, after any commit, on rollback and
  // abandon. `governance` and NOT in any built-in bundle: committing a foreign book into the real
  // ledger is an act a workspace grants deliberately through `define_role` (owner holds it via
  // CAPABILITY_IDS), never handed out by a bookkeeping default. Widening bookkeeper/treuhaender is a
  // policy decision the owner makes with the plan machine, not something the harness decides in passing.
  { id: 'commit_migration', group: 'governance' },
  // G20, the migration family's LAST capability, arriving by the standing route in the commit that
  // registers the eleven implementation-project verbs it gates. `governance` and NOT in any built-in
  // bundle: running a client's cutover (the project object, its runbook tasks, its decisions, its
  // parallel-run declarations) is an act a workspace grants deliberately through `define_role` (owner
  // holds it via CAPABILITY_IDS), never handed out by a bookkeeping default, the `commit_migration`
  // shape one register over. The SIGN-OFFS deliberately do NOT ride this capability: they ride
  // `commit_migration` (US-G20.5), because signing is the human half of committing money-path steps.
  // The roster metadata read (`implementation_project_list`) rides `read_master_data`, so a mandate
  // member can compose the cross-client roster without holding this governing right.
  { id: 'manage_implementation', group: 'governance' },
  // G22 checklists (D127), arriving by the standing route in the commit that registers the five
  // `checklist_*` writes it gates. `governance` like its G20 sibling, but held by `bookkeeper`,
  // `treuhaender` and `agent` by default: a checklist run is the bookkeeping rhythm itself (the MWST
  // period walked item by item), it posts nothing, and every item that DOES touch a filed figure acts
  // through a verb carrying its own gate (`vat_mark_filed` on `vat_file`). Reads ride `read_books`.
  { id: 'manage_checklists', group: 'governance' },
  // G12 Testmandant, arriving by the standing route: the name lands here in the commit that registers
  // the verb it gates (`go_productive`). OWNER-ONLY by default, mirroring G04's `manage_data_restore`:
  // going productive mints real books out of a trial, the least reversible act in the product, so it
  // is `governance` and NOT in any built-in bundle (owner holds it via CAPABILITY_IDS), granted
  // deliberately through `define_role`. `go_productive` requires it TOGETHER WITH `commit_migration`
  // (it also commits money-path data), and is confirm-gated (type-to-confirm, engine-side) and
  // denylisted from automation, so the capability is one of three fences, not the only one.
  { id: 'promote_workspace', group: 'governance' },
  // G04 data freedom, arriving from RESERVED_CAPABILITIES by the standing route: the name lands here
  // in the commit that registers the verbs it gates (`export_workspace`, `create_backup`,
  // `list_backups`, `delete_backup`). `governance` and NOT in any built-in bundle: exporting or
  // backing up the whole workspace to a portable file is a governing act over the client's data a
  // workspace grants deliberately through `define_role` (owner holds it via CAPABILITY_IDS), never
  // handed out by a bookkeeping default. Its sibling `manage_data_restore` stays reserved (restore is
  // pre-workspace, the `create_workspace` shape, so no boundary gate can resolve it, spec §0a.4).
  { id: 'manage_data_export', group: 'governance' },
  // G13 GL archive, arriving by the standing route: the name lands here in the commit that registers
  // the verb it gates (`gl_archive_purge`). `governance` and NOT in any built-in bundle: destroying
  // the prior system's records, even lawfully after OR 958f expires, is an act a workspace grants
  // deliberately through `define_role` (owner holds it via CAPABILITY_IDS), never handed out by a
  // bookkeeping default. The verb is also confirm-gated with a recorded reason and denylisted from
  // automation, so the capability is the LAST of three fences, not the only one.
  { id: 'purge_archive', group: 'governance' },
  // I04 three-way match, the `money` register: recording a match clears a bill for payment, and
  // overriding / reversing one is a stronger money-authority act. `match` joins the three editable
  // built-ins (bookkeeper/treuhaender/agent, the D02 purchasing surface they already run);
  // `match_override` joins bookkeeper + treuhaender but NOT the agent, so an automatic matcher can
  // record in-tolerance matches yet never force a variance through (the D02 automation-denylist
  // reasoning). `owner` holds both via CAPABILITY_IDS.
  { id: 'purchasing.match', group: 'money' },
  { id: 'purchasing.match_override', group: 'money' },
  { id: 'diagnostics.read', group: 'governance' },
  // M02 §I sync/publish contract, arriving by the standing route in the commit that registers the six
  // verbs they gate. `manage_sync` (`governance`, NOT in any built-in bundle: enabling egress from the
  // local file is a workspace-owner consent act, owner holds it via CAPABILITY_IDS) gates the two
  // publish dials; `sync.read` (`reading`, and ABSENT from READ_CAPABILITIES so `viewer` never picks up
  // the raw integration feed) gates the three stream reads. The managed tier runs under a define_role
  // role holding exactly `sync.read`, never standing membership in the tenant's books.
  { id: 'manage_sync', group: 'governance' },
  { id: 'sync.read', group: 'reading' },
  // N00 environment landscape (D126), arriving by the standing route in the commit that registers the
  // seven env_* verbs they gate. `landscape.manage` (`governance`, NOT in any built-in bundle: a
  // host-level landscape mutation is granted deliberately through `define_role`, owner holds it via
  // CAPABILITY_IDS) gates the four writes; `landscape.read` (`reading`, and IN READ_CAPABILITIES so
  // every member incl. `viewer` can see which environment they are in, the `egress.read` shape) gates
  // the three reads.
  { id: 'landscape.manage', group: 'governance' },
  { id: 'landscape.read', group: 'reading' },
  // Phase B (D-ENV-5): the owner-only secret-retaining copy override. `governance`, NOT in any built-in
  // bundle (owner holds it via CAPABILITY_IDS), the `landscape.manage` sub-gate for `env_copy`.
  { id: 'landscape.retain_secrets', group: 'governance' },
];

/** Every capability id, for the `owner` short-circuit and for `define_role` validation. */
export const CAPABILITY_IDS: readonly Capability[] = CAPABILITIES.map((c) => c.id);

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_IDS);

/** Is `name` a live registry entry? The ONE membership test `defineRole` may use. */
export function isCapability(name: unknown): name is Capability {
  return typeof name === 'string' && CAPABILITY_SET.has(name);
}

/**
 * Names this capability has NOT shipped, each with the capability that owns it.
 *
 * Recorded rather than dropped so the name is not silently re-used to mean something else, and so
 * the reader of a spec that cites one (A25 cites `review`, G01 cites `manage_automations`) can
 * see that the citation is a promise rather than a fact. Moving a name from here to `CAPABILITIES`
 * is the same commit that registers the verb it gates.
 *
 * G00's two names, `manage_custom_fields` and `manage_saved_views`, LEFT THIS LIST on 29.07.2026 by
 * exactly that route: they now gate real verbs, so they are live registry entries above and the
 * citation in G00's spec is a checked fact. `manage_automations` left it the same day for the same
 * reason, and it is NOT in any built-in bundle: deciding what the ledger does unattended is granted
 * deliberately through `define_role`, never handed out by a bookkeeping default.
 */
export const RESERVED_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  // A25's `review` and `export` LEFT THIS LIST on 03.08.2026 by the standing route: both now gate
  // real verbs (comment/flag/approve; the three export reads) and are live registry entries above.
  // G10's `manage_import` LEFT THIS LIST on 03.08.2026 by the standing route: it now gates the G10
  // migration-map verbs and is a live registry entry above. The reserved owner label read "G03
  // onboarding import"; D86 moved G03's three column-mapping verbs into G10, which is why the
  // migration family registers it first and G09 confirms it.
  // `manage_plugins` LEFT THIS LIST on 2026-08-06 by the standing route: it now gates the five G02
  // plugin lifecycle verbs and is a live registry entry above (owner-only by default).
  // `manage_data_export` LEFT THIS LIST on 2026-08-06 by the standing route: it now gates the four
  // G04 artifact verbs and is a live registry entry above. `manage_data_restore` STAYS reserved, and
  // deliberately so: restore mints the tenant (the `create_workspace`/`onboard_client` shape), so the
  // A24 boundary carries no `workspaceId` to resolve a capability against and the load guard would
  // refuse a gate on it. It would gate no enforceable verb, so it is a name held (not a rail), and
  // restore's real fences are the never-overwrite rule, the P8 `confirmed` gate and the pre-commit
  // invariant check. The name is kept so a later capability cannot repurpose it (spec §0a.4).
  ['manage_data_restore', 'G04 data restore (pre-workspace; not a boundary gate, see spec 0a.4)'],
  ['manage_document_templates', 'G05 document templates'],
  // `manage_dispatch_texts` LEFT THIS LIST on 2026-08-06 by the standing route: it now gates
  // `dispatch_text_upsert` (G05 §10) and is a live registry entry above.
  // `hr.manage` and `hr.sensitive` LEFT THIS LIST on 2026-08-04 by the standing route: both now gate
  // real E02 verbs and are live registry entries above (`hr.sensitive` stays A34's AHV export gate
  // too). `hr.read`, `spesen.submit` and `spesen.approve` were never reserved names; they are new
  // domains E02 brought.
]);

/** The five built-in role ids. `owner` and `viewer` are the two fixed anchors. */
export type BuiltinRole = 'owner' | 'viewer' | 'bookkeeper' | 'treuhaender' | 'agent';

export const OWNER_ROLE = 'owner';
export const VIEWER_ROLE = 'viewer';

/**
 * WHAT `viewer` RESOLVES TO, now that reads are gated. A compile-time constant, exactly like the
 * `owner` anchor, and for the same reason.
 *
 * Before D50 this was the empty array and `capabilityFor` answered `false` for every capability,
 * because a viewer held no WRITE and reads were not gated at all. Gating reads without moving this
 * would have made a read-only invite read nothing, which is the opposite of what it is for. So the
 * viewer anchor becomes "every read domain, and no write".
 *
 * It is NOT simply `READ_CAPABILITIES`, and the two exceptions are the point of a per-domain cut:
 *
 *   `read_members`     a viewer looks at the BOOKS. Who else has access is a governance question,
 *                      and `manage_members` is owner-only among the built-ins for the same reason.
 *                      An operator who wants a viewer to see the roster grants it a custom role,
 *                      which is exactly the expressiveness D50 paid for.
 *   `diagnostics.read` already a deliberate second gate before any of this (G08 §3): recorded
 *                      diagnostics carry journal material, and `viewer` has never held it. Keeping
 *                      that true is a constraint on this change, not an oversight in it.
 *
 * `read_automations` IS HELD, and it is the one place where withholding a read would have taken a
 * safety property with it. G01 leaves `disable_automation_rule` ungated so that whoever is watching
 * can halt a rule writing to an append-only ledger, and a `viewer` is exactly who is watching. A
 * rule can only be halted by its `ruleId`, and the only source of a `ruleId` is
 * `list_automation_rules`, so a viewer without this capability holds a stop button it can never
 * aim. It is also the consistent answer: this is a read domain, and the only read domain `viewer`
 * is denied is `read_members`, for a governance reason that does not apply here.
 *
 * Still a constant and never a `role_def` row, so no migration, no `define_role` call and no
 * hand-edited database can widen it.
 */
export const VIEWER_CAPABILITIES: readonly Capability[] = READ_CAPABILITIES.filter(
  (c) => c !== 'read_members',
);

/**
 * The two anchors, named once so no other module restates the condition.
 *
 * `defineRole` and `archiveRole` both reject these with `builtin_fixed`, and `capabilityFor`
 * short-circuits on both before it touches `role_def`.
 */
export const FIXED_ROLES: readonly string[] = [OWNER_ROLE, VIEWER_ROLE];

export function isFixedRole(roleId: unknown): boolean {
  return typeof roleId === 'string' && FIXED_ROLES.includes(roleId);
}

/** The three built-ins a workspace MAY reshape via `defineRole`. */
export const EDITABLE_BUILTIN_ROLES: readonly string[] = ['bookkeeper', 'treuhaender', 'agent'];

export function isBuiltinRole(roleId: unknown): roleId is BuiltinRole {
  return isFixedRole(roleId) || (typeof roleId === 'string' && EDITABLE_BUILTIN_ROLES.includes(roleId));
}

/**
 * The code-level default bundle for each editable built-in.
 *
 * These are DEFAULTS and not the matrix: a workspace that has never called `defineRole` resolves a
 * built-in through this table, and one that has resolves it through its `role_def` row instead.
 * That is why the seed in `roles.ts` is lazy and why an absent row is not a hole.
 *
 * `bookkeeper` keeps the books and cannot govern them: no `unlock_period` (prising a hard-locked
 * period open is not bookkeeping), no `vat_file` (a filing is a statement to the ESTV), no
 * `manage_chart` (the chart is the shape of the books), no `manage_settings`, no `manage_members`.
 *
 * `treuhaender` is the inverse mandate: correction, compliance and the chart, without the
 * day-to-day sales surface. A workspace whose Treuhänder also posts sales grants `issue` per
 * client, which is exactly the per-mandate tuning US-A24.3 asks for.
 *
 * `agent` is the narrowest of the three and the one that matters today, because `agent` is a real
 * actor the moment `till mcp` runs (D13). It posts, settles and drafts documents; it does NOT hold
 * `send`, because sending puts a document in front of a customer under the operator's name, and it
 * holds no `manage_*` capability at all, so it cannot reshape the books, the settings, or its own
 * grant.
 *
 * ALL THREE READ THE SAME FIVE DOMAINS, which is a decision and not a copy-paste. The reads they
 * need are not what distinguishes these mandates: a bookkeeper who may post but may not look at the
 * journal is not a role anyone wants, and a Treuhänder who may not read the sales ledger cannot
 * reconcile it. What D50 bought is not a narrower default, it is the ABILITY to be narrow, and that
 * lands on custom roles: "sees only the VAT" and "sees the books but not the customers" are now
 * expressible where they previously were not. `read_members` is the one read no built-in but `owner`
 * holds, and it is the one D50 named: a Treuhänder who sees the books and not the member list.
 *
 * NONE OF THE THREE GAINED G00's TWO CAPABILITIES, and that is a decision rather than an omission.
 * Defining a custom field reshapes what the workspace records and publishing a shared view changes
 * what everyone sees, which is the same class of act as `manage_chart`: something a workspace grants
 * deliberately through `define_role`, not something a bookkeeping default hands out. G00 registers
 * the two capabilities because its verbs need gates; WHO holds them is A24 policy, and G00 does not
 * get to widen three shipped role bundles on its way past. D50's read side did not disturb that:
 * the read domains are orthogonal to both of G00's WRITE capabilities.
 *
 * E00's PAIR JOINS ALL THREE, and `treuhaender` is the reason it exists at all. That role holds `post`
 * and not `manage_master_data`, so while E00's verbs were all `manage_master_data` the fiduciary who
 * keeps the books could post an entry and could not attach the Buchungsbeleg for it, which is the
 * document an audit actually asks to see. See `BUILT_IN_FILES` below for the split and for why `viewer`
 * holds neither half.
 *
 * `read_automations` JOINS THE BUNDLE AND `manage_automations` STILL DOES NOT, which is the same
 * split one line further out. An automation posts into the books these three mandates are
 * responsible for, so an entry appearing with no visible cause is a bookkeeper's problem and a
 * Treuhänder's problem before it is an administrator's: being able to answer "what put this here"
 * is part of keeping and of auditing the books. Deciding what fires unattended remains a governing
 * act that no bookkeeping default hands out.
 */
const BUILT_IN_READS: readonly Capability[] = [
  'read_books',
  'read_vat',
  'read_sales',
  'read_master_data',
  'read_automations',
  // E07, the trust indicator, held by all three editable built-ins for the same reason it is in the
  // viewer anchor: a bookkeeper, a Treuhänder and the agent must all be able to see that TILL is not
  // dialling out. It discloses no tenant data, so widening it costs no confidentiality.
  'egress.read',
  // N00, the environment indicator, held by all three editable built-ins for the same reason it is in
  // the viewer anchor: everyone must be able to see which environment (and whether the LIVE one) they
  // are working in. It discloses only machine topology, so widening it costs no confidentiality.
  'landscape.read',
];

/**
 * E00's PAIR, held by all three editable built-ins and by neither anchor's opposite.
 *
 * `manage_files` and `read_file_content` travel together in a bundle and are separate NAMES in the
 * registry, which is the asymmetry the owner decided on 30.07.2026: every mandate that keeps or audits
 * the books must be able to file a Buchungsbeleg and to open one, and a read-only invite must be able
 * to do neither. Splitting them lets a custom role express "may file, may not download" and its
 * inverse, which is the expressiveness D50 paid for; bundling them in the defaults is the answer to
 * "what should a bookkeeper get".
 *
 * `viewer` HOLDS NEITHER, and that is F7. It is not in `READ_CAPABILITIES`, so the viewer anchor cannot
 * pick it up, and `owner` holds it the way it holds everything, through `CAPABILITY_IDS`.
 */
const BUILT_IN_FILES: readonly Capability[] = ['manage_files', 'read_file_content'];

/**
 * E03's PAIR, held by all three editable built-ins, the `BUILT_IN_FILES` shape one register over.
 *
 * Every mandate that keeps or audits the books also chases the follow-ups around them: a
 * bookkeeper's "MWST-Abrechnung vorbereiten" recurs monthly, a Treuhänder's mandate renewals are
 * tasks on client books, and the AGENT is the persona the spec centres (US-E03.2/4: it creates
 * linked follow-ups and polls `tasks_reminders_due`). `viewer` holds neither half: `tasks.read` is
 * deliberately not in `READ_CAPABILITIES`, so the anchor cannot pick it up, and `owner` holds both
 * the way it holds everything, through `CAPABILITY_IDS`.
 */
const BUILT_IN_TASKS: readonly Capability[] = ['tasks.read', 'tasks.write'];

/**
 * B01's PAIR, held by all three editable built-ins, the `BUILT_IN_TASKS` shape one register over:
 * every mandate that keeps or audits the books also captures and corrects the hours around them,
 * and the AGENT is the persona US-B01.4 centres (it logs time and hands the approved slice to
 * B02). `viewer` holds neither half (`time.read` is deliberately not in `READ_CAPABILITIES`).
 *
 * `time.approve` is NOT in this pair, and that is the point of its existence: sign-off on the hours
 * one logged is self-review, so only `treuhaender` (below) and `owner` (via CAPABILITY_IDS) hold
 * it by default. A workspace whose operator approves their own sheets grants it via `define_role`,
 * which is the D50 expressiveness working as intended.
 */
const BUILT_IN_TIME: readonly Capability[] = ['time.read', 'time.write'];

/**
 * C01's PAIR, held by `bookkeeper` and `agent` and deliberately NOT by `treuhaender`: that mandate
 * is "correction, compliance and the chart, without the day-to-day sales surface" (the D50
 * boundary, stated above), and the deal funnel is the most day-to-day sales surface there is. The
 * bookkeeper already holds every other face of the same money (`issue` mints the invoice a won
 * deal becomes, `send` mails it, `pay` settles it), and the AGENT is the persona the C01 spec
 * centres (it creates deals, moves them, and reports the weighted pipeline). `viewer` holds
 * neither half: `deals.read` is deliberately not in `READ_CAPABILITIES`, so the anchor cannot
 * pick it up, and `owner` holds both through `CAPABILITY_IDS`.
 */
const BUILT_IN_DEALS: readonly Capability[] = ['deals.read', 'deals.write'];

/**
 * B02's READ half, held by ALL THREE editable built-ins, the `BUILT_IN_TIME`/`read_automations`
 * shape: every mandate that keeps or audits the books needs the unbilled pile and the WIP figure.
 * The bookkeeper and agent bill from it; the Treuhänder reads WIP at month-end for the OR 960c
 * angefangene-Arbeiten decision (US-B02.4), which is why this read joins `treuhaender` even though
 * the WRITE half below does not. `viewer` holds neither half (`billing.read` is deliberately not in
 * `READ_CAPABILITIES`, so the anchor cannot pick it up); `owner` holds both through `CAPABILITY_IDS`.
 *
 * `billing.generate` is NOT in this pair, and that is the point of its existence: turning approved
 * time into an invoice is the day-to-day sales surface, which `treuhaender` deliberately excludes
 * (the `issue`/`deals` boundary, stated above). So the write half joins `bookkeeper` and `agent`
 * explicitly below, beside the `issue` they already hold, and not this shared read.
 */
const BUILT_IN_BILLING_READ: readonly Capability[] = ['billing.read'];

/**
 * B03's read, held by all three editable built-ins, the `BUILT_IN_BILLING_READ` shape one register
 * over: the bookkeeper and agent work the projects whose margin this reports, and the Treuhänder is
 * US-B03.2's own persona (warning a client before the budget burns is the mandate). `viewer` holds
 * it not: `costing.read` is deliberately absent from `READ_CAPABILITIES` (the revDSG pay-data gate,
 * spec B03 §3), and `owner` holds it through `CAPABILITY_IDS`.
 */
const BUILT_IN_COSTING: readonly Capability[] = ['costing.read'];

/**
 * E02's read, held by all three editable built-ins, the `BUILT_IN_TASKS`/`BUILT_IN_TIME` shape one
 * register over: every mandate that keeps or audits the books also fields the questions around who is
 * away and who is owed Spesen. Only the READ joins the bundle: `hr.manage`, `hr.sensitive`,
 * `spesen.submit` and `spesen.approve` stay owner-only (granted through `define_role`), because
 * maintaining personnel data, revealing an AHV number, and approving money out of the business are
 * each policy a workspace configures. `viewer` holds neither: `hr.read` is deliberately not in
 * `READ_CAPABILITIES`, and the self-scoping filter narrows a bare `hr.read` holder to their own rows.
 */
const BUILT_IN_HR: readonly Capability[] = ['hr.read'];

/**
 * F01's TRIO, held by all three editable built-ins, the `BUILT_IN_TASKS`/`BUILT_IN_TIME` shape: every
 * mandate that keeps or audits the books also builds and runs the recurring cuts of the numbers around
 * them (the open-items list for one segment, the unbilled-time CSV for the mandate file). All three
 * hold the full trio because building and running are the whole story for each persona, and a run
 * produces only a LOCAL artifact (P8: delivery stays draft, so no outbound risk). `viewer` holds none:
 * `reports.read` is deliberately not in `READ_CAPABILITIES`, and the run/preview verbs re-assert each
 * source's own read gate, so a report can never widen what its runner may see. `owner` holds all three
 * through `CAPABILITY_IDS`.
 */
const BUILT_IN_REPORTS: readonly Capability[] = ['reports.read', 'reports.write', 'reports.run'];

/**
 * `contacts.merge` JOINS EXACTLY THE BUNDLES THAT ALREADY HELD `manage_master_data`, and that is the
 * whole point of how the F5 split landed: every role that could merge or anonymise a contact
 * yesterday (through the coarse grant) still can, and every role that could not still cannot, so no
 * shipped role's effective surface moves. What the split buys is expressiveness for CUSTOM roles: an
 * operator can now strip the two destructive-adjacent verbs from a role while keeping ordinary
 * master-data edits, which is the same purchase D50 made on the read side and D62 on the files side.
 * `treuhaender` does not gain it for the same reason it never held `manage_master_data`: the mandate
 * boundary D50 was decided on.
 */
export const BUILTIN_ROLE_DEFAULTS: ReadonlyMap<string, readonly Capability[]> = new Map([
  [
    'bookkeeper',
    [
      ...BUILT_IN_READS,
      ...BUILT_IN_FILES,
      ...BUILT_IN_TASKS,
      ...BUILT_IN_TIME,
      ...BUILT_IN_DEALS,
      ...BUILT_IN_BILLING_READ,
      ...BUILT_IN_COSTING,
      ...BUILT_IN_REPORTS,
      // B02: billing approved time IS bookkeeping, and this bundle already holds every other face of
      // the same money (`issue` mints the invoice a billing run drafts, `send` mails it, `pay`
      // settles it). The draft-only P8 gate keeps it from transmitting anything unattended.
      'billing.generate',
      // B04: managing mandates and drafting their periodic invoices is bookkeeping, beside billing.generate.
      'retainer.manage',
      ...BUILT_IN_HR,
      'post',
      'pay',
      'issue',
      'send',
      // E01: requesting and transmitting signatures rides beside `issue`/`send`, whose split it
      // mirrors: this bundle already holds every other outbound face, so it holds both halves.
      'sign.write',
      'sign.send',
      // A15: chasing the receivables IS bookkeeping, and this bundle already holds every other
      // face of the same money (`issue` mints the invoice, `send` mails it, `pay` settles it).
      'dun',
      'manage_periods',
      'manage_master_data',
      'contacts.merge',
      // G22: walking the MWST period checklist IS bookkeeping and posts nothing.
      'manage_checklists',
      // F02: opening a customer's portal access rides beside the sales surface this bundle already
      // holds whole (issue/send/dun + the deals/billing reads), the same class of act as issuing the
      // invoice the grant exposes. `treuhaender` does not gain it, the D50 sales-surface boundary.
      'portal.manage',
      'manage_vat_config',
      // J03: the GmbH bookkeeper (persona G) is who runs the period end and picks the valuation
      // basis for it, and this bundle already holds `manage_periods` and `manage_master_data`, so
      // the act sits inside a mandate it is already the centre of.
      'inventory.setup',
      // I03: capitalising landed cost is the GmbH bookkeeper's period-end act (persona G), beside the
      // `post` and `manage_periods` this bundle already holds.
      'procurement.landed_cost',
      // I04: matching a vendor bill against its order and receipt IS bookkeeping (this bundle already
      // holds the whole D02 purchasing surface via manage_master_data, plus post/pay), and overriding
      // a small agreed variance with a recorded reason is the same money-authority the `post`-riding
      // D02 override always gave a bookkeeper.
      'purchasing.match',
      'purchasing.match_override',
      'diagnostics.read',
    ],
  ],
  [
    'treuhaender',
    [
      ...BUILT_IN_READS,
      ...BUILT_IN_FILES,
      ...BUILT_IN_TASKS,
      ...BUILT_IN_TIME,
      // B02: the WIP report is the fiduciary's month-end read (US-B02.4, the OR 960c angefangene
      // Arbeiten decision), so `billing.read` joins this mandate. `billing.generate` does NOT: turning
      // time into an invoice is the day-to-day sales surface this mandate excludes (the `issue`/`deals`
      // boundary), so a Treuhänder who also bills gets it per client through `define_role`.
      ...BUILT_IN_BILLING_READ,
      // B03: cost-to-date vs budget is US-B03.2's own persona (the Treuhänder warns the client
      // before the budget burns), so the profitability read joins this mandate.
      ...BUILT_IN_COSTING,
      // F01: the recurring client export (the monthly open-items CSV for the mandate file) is the
      // Treuhänder's own analytics tooling, so the trio joins this mandate.
      ...BUILT_IN_REPORTS,
      ...BUILT_IN_HR,
      // B01: the timesheet sign-off is the fiduciary's act (the `review` reasoning one register
      // over): approving the hours one logged is self-review, so neither `bookkeeper` nor `agent`
      // holds it.
      'time.approve',
      // B04: unlike `billing.generate` (the day-to-day sales surface this mandate excludes), a
      // retainer IS the Treuhänder revenue model (spec §1), so this mandate manages mandates. The
      // periodic invoice is a draft (P8); the fiduciary owns the recurring-fee relationship.
      'retainer.manage',
      // E01: the Treuhänder PREPARES sign requests across client mandates (US-E01.2's own persona)
      // and deliberately does NOT hold `sign.send`: transmitting a client's counterparty data to a
      // provider is the client's outbound act, granted per mandate through `define_role`, the same
      // boundary that keeps `send` out of this bundle.
      'sign.write',
      'post',
      'manage_periods',
      'unlock_period',
      'vat_file',
      'manage_vat_config',
      'manage_chart',
      // G22: the MWST period checklist is the fiduciary's monthly rhythm made structural; it posts nothing.
      'manage_checklists',
      // A25: the fiduciary review sign-off and the filing exports are this mandate's whole monthly
      // job (comment/flag/approve, then lock via manage_periods above, then export). Neither joins
      // `bookkeeper` or `agent`: sign-off on the books one keeps is self-review, and the agent
      // prepares (on `post`) but never signs or exports (P8).
      'review',
      'export',
      // J03, and the reason the capability exists at all. This mandate is answerable for the Bilanz
      // and for demonstrating Stetigkeit under OR 958c, so it must be able to choose the valuation
      // basis. It deliberately does not hold `manage_master_data`, which is what the old gate
      // required, so before this the fiduciary who signs off the inventory figure could not decide
      // how it was computed while the day-to-day bookkeeper could.
      'inventory.setup',
      // I03: the fiduciary is answerable for the Bilanz and for demonstrating that inventory is at
      // acquisition cost (OR 960), so capitalising landed cost joins this mandate beside `post` and
      // `inventory.setup`.
      'procurement.landed_cost',
      // I04: the fiduciary answerable for the accounts payable checks a bill against its order and
      // physical receipt before it is cleared, and may override an agreed variance with a recorded
      // reason (the compliance mandate, beside `review` and `manage_periods` above).
      'purchasing.match',
      'purchasing.match_override',
      'diagnostics.read',
    ],
  ],
  // A15's `dun` joins the agent bundle because proposing a Mahnlauf is the agent's whole story
  // here (US-A15.5): it drafts, a human approves. The agent still holds no `send`, so
  // `send_dunning_run`'s ALL-OF refuses it exactly as `send_invoice` does, and issue/send both
  // additionally wait on the P8 confirm for every actor.
  // B02: the agent is the persona US-B02.1/2 centre (it polls the unbilled preview and proposes
  // billing runs, always stopping at a draft under P8), so it holds both halves, beside the `issue`
  // it already carries. It holds no `send`, so it can never transmit the draft it generates.
  // B03: the agent is US-B03.2's polling persona (it reads budget-vs-actual and margin to draft the
  // follow-up a human approves), so the costing read joins this bundle too.
  // E01: the agent DRAFTS sign requests (US-E01.3: an accepted quote drops a signature request
  // without a human re-keying it) and holds no `sign.send`, so it can never transmit the draft it
  // prepares: the same shape as `issue` without `send`, and P8's confirm gate stands behind it.
  // F02: the agent is the persona US-F02.3 centres (it drives portal_quote_accept to test a grant end
  // to end, and drafts grants an accepted quote drops), so `portal.manage` joins this bundle beside
  // the sales surface it already carries. It holds no `send`, and portal_grant_send is P8 confirm-
  // gated, so it can never transmit a grant unattended.
  // F01: the agent is a first-class F01 persona (US-F01.2: "as an agent, I want to run a saved report
  // and get a CSV/PDF artifact"), so the trio joins its bundle; a run produces only a local artifact.
  // E04's pair joins ONLY this bundle: the local-correspondence cluster exists so the agent can
  // read the corpus (E05), draft against it (E06) and write the draft back, all without a socket.
  // `bookkeeper` and `treuhaender` hold neither half: Art. 321 correspondence is not the
  // bookkeeping mandate, and widening either is a `define_role` decision the practitioner makes.
  ['agent', [...BUILT_IN_READS, ...BUILT_IN_FILES, ...BUILT_IN_TASKS, ...BUILT_IN_TIME, ...BUILT_IN_DEALS, ...BUILT_IN_BILLING_READ, ...BUILT_IN_COSTING, ...BUILT_IN_REPORTS, 'billing.generate', 'retainer.manage', ...BUILT_IN_HR, 'post', 'pay', 'issue', 'dun', 'sign.write', 'portal.manage', 'manage_master_data', 'contacts.merge', 'procurement.landed_cost', 'mail.read', 'mail.write', 'voice.read', 'voice.write', 'draft.write', 'purchasing.match', 'manage_checklists']],
]);

/** A default bundle for a role name, or undefined when the name is not an editable built-in. */
export function defaultCapabilitiesFor(roleId: string): readonly Capability[] | undefined {
  return BUILTIN_ROLE_DEFAULTS.get(roleId);
}
