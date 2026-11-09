# A41.3 re-cut v3 "one holder truth": paper critic review

Non-author paper critic, 07.11.2026. Target: `docs/specs/specs/A41-beleg-abgleich.md`, section "A41.3 re-cut v3",
on `claude/a41-3-assignment` at `f00e4af03`. Code read at that head. No code was changed.

## Verdict: PAPER FAIL (amendable on paper, no new design needed)

The idea holds: one holder read, with the assignment as a holder, enforced at the write. Three claims in the text
are false as written, and one product call strands lines. Each needs an edit to the paper before the build.

## H1. "One enforcement" is not one chokepoint: three writers put a file on a record without `linkFile`

- `files/files.ts:589` `newFileVersion` inserts the new head WITH the old row's `entity_kind`/`entity_id`: new
  bytes land on a record without `linkFile`. Its own guard (`:575`) runs only for a live booking target. D11 is
  in the enforcement list, but the guard test of point 3 checks only `linkFile`, so D11 is unguarded.
- `files/files.ts:1608` `repointFileLinks` (contact merge) rewrites `entity_id` directly.
- `banking/belegAssignment.ts:292` `unfileFromLine` sets the link to NULL directly (the "move off" direction).
- Amend: name the call sites (`linkFile`, `newFileVersion`) plus the exemptions with reasons. Make the guard a
  SQL-level guard: the only statements that write a non-NULL `stored_file.entity_kind`/`entity_id`, or INSERT a
  `stored_file` row with them, are in that list.

## H2. The enumeration D1 to D17 misses writers and one holder decision

- Writers missing from the table, all `linkFile` callers whose outcome the person/machine split now decides:
  - `migration/steps.ts:602`, the bexio documents step, which links every imported document to `migration_plan`;
  - `banking/ebics/channel.ts`, `banking/managed/channel.ts`, `payroll/handoff.ts`, `portal/vendorPortal.ts`,
    `sales/deliveryNotes.ts`, `sales/ebill.ts`, `customization/documentTemplates.ts`, `reportbuilder/reports.ts`.
- Direct writers missing from the table:
  - `data/portability.ts` `loadIntoNewWorkspace` copies `stored_file` and `beleg_assignment` wholesale;
  - `store/migrations.ts` generation 19 inserts `beleg_assignment_file` directly. The point-3 rule "only the
    store and `receiptHolders` read `beleg_assignment_file`" also needs this one named.
- `files/files.ts:1005` `refuseReceiptLink` is a holder-like decision ("filed elsewhere") that the table does not list.
- The migration step matters in practice: a receipt in TILL's Belegeingang and the same PDF in the bexio export
  share bytes. Under v3 the commit then either refuses the WHOLE documents step (a machine seat: one throw, the
  forEach is not per-file isolated) or silently releases the person's assignment (a person seat, see H3).

## H3. The implicit person release strands the held line (the open product call)

- A person act that writes the bytes ANYWHERE releases the row with reason `person`, for example:
  - filing a copy on a contact;
  - committing the migration documents step;
  - attaching a twin to booking B.
- `banking/belegAssignmentStore.ts:201` `personBlocked` reads reason `person` as "not this line's receipt", so
  the engine never re-pairs that file with the line.
- In the twin case the original file stays filed on the open line. The pool excludes a file on a `bank_txn`
  (`belegMatch.ts:212`), so the line waits `no_beleg` forever. If it is ever booked, the liveness transition
  refuses the bytes, because B holds them.
- Nothing tells the person. Amend:
  - release only for a booking-kind target, a real competing claim; a non-booking target is no move and needs
    no release;
  - give the release its own reason that does not block re-creation;
  - say what happens to the line's own filing.

## H4. The guard test as described is partly theatre

- "No module outside `receiptGuard.ts` selects `stored_file` by `sha256`" needs a long allowlist (pool, capture
  intake dedupe, blob refcount, `erasePendingFile`, drop-link).
- "`linkFile` calls `assignmentHoldRefusal` unconditionally" cannot be proved by grep: a call inside an `if` passes.
- Keep the behavioural half of point 5: each door is driven with an assigned file, and a mutation at each call site
  goes red. Add the SQL writer guard of H1.

## H5. Probe premises

- These keep their intent: r2 M3 (stronger), Q5, H4, H5, I1, L2, L3.
- Missing from point 4: r1 B4 asserts that an agent's `files_link` move to a contact succeeds
  (`test/critic/a41-3-r1-bite.test.mjs:94`). That move is now refused, so B4 needs the same rewrite as M3, its
  pool exclusion reached by direct state setup.

## H6. Book-again and the D142 drafted attach (LOW)

- `bookAgain` and `files.duplicate_beleg` correctly sit behind the assignment refusal.
- A person approving an agent's Vorschlag that attaches an assigned receipt is refused as a machine act. The row
  stays pending with no way forward except Lösen first. The card should offer Lösen; otherwise a person act
  "wins" everywhere except through an approval.

## Round 2 (revision 2 at `0403e956c`): PAPER FAIL, narrower

Closed:
- H2: the D1 to D25 list is complete for writers, and the bexio step is isolated per file.
- H4: the SQL writer guard is derived from the code.
- H5: B4 is rewritten like M3.
- H6: the refusal carries `holders[]` and the Studio offers "Lösen".

H1 and H3 are closed in intent but open three new holes:

- **R2-1 (MED), order makes a half state.** Under `move` the spec releases through `closeAssignment` and unfiles
  the line, "then the act's own guard runs". That guard RETURNS its refusal: `linkFile` returns `judged` at
  `files/files.ts:696`. `rememberIdempotent` commits a returned Err with every write before it
  (`store/sqlite-store.ts:1193`). So a person's link that `files.duplicate_beleg` refuses leaves the assignment
  released and the line unfiled, while the receipt never moved.
  - Amend: every refusal is decided first, read-only, and the release is the last write before the link; or the
    release throws on any later refusal.
- **R2-2 (MED), multi-file groups.** "The line's own filing of that file is removed" covers one file. Move F1 of a
  two-file group and F2 stays filed on the open line with no assignment. The pool excludes a file filed on a line,
  so the line waits `no_beleg` forever: the claim "holds no receipt, re-pairable" is false.
  - Amend: unfile every file of the released group, or release only the moved file.
- **R2-3 (MED), the same receipt comes back.** A person move onto a booking-kind target that is not yet live (a
  draft bill, as a twin) is no holder (`liveReceiptHolders`: live bookings only). The original file is unlinked,
  so it is back in the pool, and `person_moved` does not block. The engine re-pairs the SAME receipt with the old
  line and autobooks it, and the bill double-evidences it once it posts.
  - Amend: any booking-kind filing, live or draft, holds against the pool; or `person_moved` blocks that pair
    until the target is decided.
- **R2-4 (LOW), "contacts only" is a caller fact, not a code fact.** `repointFileLinks` (`files.ts:1608`) takes
  any `entityKind`, and today it has no caller at all. A later merge of a booking kind would move assigned files
  under the named exemption.
  - Amend: assert `entityKind === 'contact'` in the function, and let the guard test check that assertion.

## Round 3 (revision 3 at `93eb2a6a0`): PAPER FAIL, one blocking item

Closed:
- R2-1: the write-order rule, the `holdPlan` read, and a later refusal is thrown.
- R2-2: the whole group is unfiled.
- R2-4: the contact assertion is in the function body and the guard checks it.
- R2-3: withdrawn, my premise was wrong. `liveReceiptHolders` already counts a draft bill (`status <> 'void'`,
  `files/receiptGuard.ts:261`), a live claim and a non-cancelled document, so a receipt moved onto a draft stays
  held.

New findings:
- **R3-1 (MED, blocking): the `refuse` default contradicts H4 and I-B.**
  - Point 4 says a person's `capture_commit` of an assigned capture "releases `capture_committed`, H4 unchanged".
    But a bill is a booking-kind target, so under `refuse` that person is refused.
  - It reaches ENGINE rows too. The engine pairs every unique trusted receipt on its own, so the ordinary A31 flow
    (a person commits a receipt into its vendor bill, whose payment is the very line the engine paired) is refused
    by default and needs "Lösen" first.
  - That "Lösen" records reason `person`, which then blocks the engine for good.
  - I-B says "a person always wins" over an engine row.
  - Amend: `belege.assigned_move` governs PERSON rows only; a person act always releases an `engine_unique` row
    (a reason that does not block).
- **R3-2 (LOW): GL archive entries are no holder kind.** `gl_archive_entry` is not in `RECEIPT_BOOKING_KINDS`
  (`receiptGuard.ts:59`). A receipt filed on an imported bexio booking can still back a TILL line booking.
  - Amend: name it a holder, or record why it is not.
- **R3-3 (LOW): the rollback probe covers too little.** "No door can interleave" is not guarded by the SQL test,
  and the full-rollback probe covers one door.
  - Amend: require it for each composite door: `book_bank_line attach`, `capture_commit`, `post_entry attach`,
    `expense_line_upsert`.

Checked and fine:
- The other draft kinds: credit notes are `document`; delivery notes and payroll hand-offs are non-booking.
- `payment` has no status filter, so it over-holds, which fails closed.

## Round 4 (revision 4 at `831cd388c`): PAPER PASS

Closed:
- R3-1: the setting governs person rows only, a person always overrides an engine row (`person_overrode`, no
  block), and `capture_commit` has its own rule, so H4 holds.
- R3-2: GL archive entries are not holders, with the reason written down, and a probe pins it.
- R3-3: full-rollback probes and a `holdPlan` mutation for each composite door.

The reason table:
- No agent or engine step reaches a blocking reason. Only `release_beleg` and `assign_beleg` write `person` or
  `person_rejected`, and both refuse a governed seat before any draft.
- The engine pass releases only with non-blocking reasons.
- `person_rejected` has a path back: a person's `assign_beleg` of that pair is newer and lifts the block. The
  receipt still shows as a `belegCandidates` match ("Anhängen"), because `personBlocked` filters only the engine
  pass.

One LOW for the build, not blocking:
- **R4-1 (LOW): `personBlocked` keys on `(bank_txn_id, file_id)`, not on the bytes.** A discarded and re-dropped
  receipt gets a new file id, so the engine may re-pair that rejected receipt with the same line.
  - Under the default `confirmed` trust this needs a person's new confirmation of the re-drop. Under
    `belege.autobook_figure_trust = agent` an agent alone can do it.
  - Amend in the build: also match on `sha256`.
