/**
 * A31, Belegeingang (`/capture-inbox`): the document-capture review queue.
 *
 * WHY A NEW SURFACE. No existing screen pairs an original document view with a provenance-stamped
 * field proposal for review: `Bills` is a payables list and `Files` is a filing cabinet, and forcing
 * this onto either would distort it. The queue is the seam the whole capability exists to provide, so
 * it earns one rail item, placed with the creditor surfaces because that is where a captured supplier
 * document lands.
 *
 * EVERY FIELD CARRIES ITS PROVENANCE, glyph plus text, never colour alone (DESIGN.md, WCAG 2.2). A
 * `qr`/`swico` value is what the paper machine-readably stated; an `operator` value is a human
 * correction; the badge says which, because provenance is the audit trail the capability is FOR.
 *
 * THE ONE PRIMARY ACTION IS COMMIT: the accent is spent on Übernehmen and nowhere else. Committing
 * delegates to A17/E02, whose own capability the engine re-checks, so the button is pre-disabled with
 * a requires-bookkeeper tooltip when the actor lacks `post` rather than shown-then-rejected.
 *
 * ## ÜBERNEHMEN CREATES AND POSTS, IN ONE ACT (friction ledger F-03, J3.1, 2026-09-05)
 *
 * Measured on the golden ledger, the pane could not finish its own story: the engine refused
 * `needs_account` and the pane had no control to supply the account (C 9 against an ideal of 3, and
 * a detour over /bills for the "Buchen"). Now the pane carries the two pickers the commit needs, the
 * shared typeable combobox for the expense account (defaulted from the vendor's LAST bill, recognition
 * over recall) and a vendor picker whenever no vendor matched, and one press runs `capture_commit`
 * then `post_vendor_bill` back to back. The engine contract is unchanged: A31 still posts nothing
 * itself (its tripwire holds), the posting is A17's own verb called by this surface as the second
 * half of the person's one act, with its own idempotency key. Under an agent dial at `ask` that
 * second verb is what gets drafted; for the Studio seat it posts. A commit that succeeds but a post
 * that is refused leaves the draft bill in place and names the refusal, so nothing is lost.
 *
 * THE VORSTEUER IS DECIDED BEFORE THE ACT, NEVER DEFAULTED TO NOTHING (critic F3, 2026-09-05). The
 * engine falls back to a `tax_code` field the capture never proposes, so the one act used to post a
 * VAT-bearing bill gross with no code and no Vorsteuer leg, silently, where the two-step path had
 * left a draft a person could still correct. Now the pane carries the code as a third field and
 * defaults it the way it defaults the account: the vendor's newest POSTED bill's code (its "none"
 * counts as a decision too), else, when the capture carries a Swico `/32/` rate, the ONE active input
 * code whose effective rate on the invoice date equals it (`vat_preview`, the engine's own
 * resolution, so no statutory rate lives here; zero or several matches propose nothing, A31 §4). A
 * workspace with no VAT codes books without VAT and says so. When nothing can be defaulted the act
 * waits for the choice: the button is disabled and the consequence sentence says what is missing.
 * Whatever will post, the sentence names it ("mit Vorsteuer VST-M" / "ohne MWST").
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The queue is the shared `DataTable` (frame overflow, sticky header, density and the five states in
 * one place), row-click opening the selected capture; the per-row discard rides an actions column via
 * the shared `OverflowMenu`. The page header and the drop affordance are the shared `SurfaceHeader`,
 * and the review moved from a persistent second column into the shared `DetailDrawer`, which adds the
 * focus trap, Escape and scrim the bespoke split panel lacked, and gives the queue the full width
 * until a document is opened. The surface-specific styling that survives is the drop zone, the status
 * badges, the field key/value table and its provenance/confidence badges, and the commit target set.
 *
 * The FIELD-LEVEL provenance (qr / swico / operator, per value) is this capability's own concept and
 * stays; it is not the C3 `Provenance` component, which records who/agent/when for a whole record and
 * has no actor in this read model, so C3 is not adopted here. The one `ConsequenceLine` (C4) is the
 * posting half's (`post_vendor_bill`): the capture verbs themselves carry no dial consequence
 * sentence. No `FilterBar`: the queue has no search or filter.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { EmptyState, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DetailDrawer } from '../../components/DetailDrawer';
import { Select } from '../../components/Select';
import { OverflowMenu } from '../../components/OverflowMenu';
import { FileDrop } from '../../components/FileDrop';
import { Status, type StatusKind } from '../../components/Status';
import { AccountCombobox, Combobox, type ComboboxOption } from '../../components/AccountCombobox';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { COMMIT_TARGET_CLASS, useCommitAck } from '../../lib/motion';
import './Capture.css';

interface CaptureField {
  key: string;
  value: unknown;
  provenance: string;
  confidence: string;
  superseded: boolean;
}
interface CaptureRow {
  id: string;
  status: string;
  qrPresent: boolean;
  swicoPresent: boolean;
  createdAt: string;
  targetKind: string | null;
  targetId: string | null;
  fields?: CaptureField[];
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Read a selected File as base64, without the data-URL prefix. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** A money field ({minor,currency}): its cell takes the shared `.t-money` (tabular, never wraps). */
function isMoneyValue(field: CaptureField): boolean {
  const v = field.value;
  return v !== null && typeof v === 'object' && 'minor' in (v as Record<string, unknown>);
}

/** Render a money field ({minor,currency}) or a plain value through the shared P11 helpers. */
function renderValue(field: CaptureField): string {
  const v = field.value;
  if (v !== null && typeof v === 'object' && 'minor' in (v as Record<string, unknown>)) {
    const money = v as { minor: number; currency?: string };
    return formatMoney(money.minor, money.currency ?? 'CHF');
  }
  if ((field.key === 'invoice_date' || field.key === 'due_date') && typeof v === 'string') {
    return formatDate(v);
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The tax-code kinds a purchase may carry: mirrors `purchaseTaxCodes` in `Bills/model.ts`. */
const PURCHASE_TAX_KINDS: readonly string[] = ['input', 'import', 'reverse_charge'];

interface PurchaseTaxCode {
  code: string;
  kind: string;
  rateBp: number;
  label: string | null;
}

/**
 * A Swico `/32/` rate ("8.1", "2.6") as basis points, by string decomposition (never a float):
 * "8.1" -> 810, "7.7" -> 770, "2.6" -> 260. Null for anything that is not a plain decimal.
 */
export function rateToBp(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (m === null) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(frac);
}

/** What the vendor was booked with last time: the newest bill's account, the newest POSTED bill's code. */
interface VendorUsual {
  accountId: string | null;
  /** `undefined` when the vendor has no posted bill; `null` when the newest posted bill carried no VAT. */
  taxCode: string | null | undefined;
}

/** The tax choice the pane sends: '' undecided (the act waits), 'none' books without VAT, else a code. */
const TAX_NONE = 'none';

/** The shared Status vocabulary for a capture's state (K-22): waiting for a look, taken over, dropped. */
function captureStatusKind(status: string): StatusKind {
  if (status === 'committed') return 'success';
  if (status === 'discarded') return 'inactive';
  return 'warn';
}

export function Capture() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canDrop = useCan(CAP.manageFiles);
  const canCommitBill = useCan(CAP.post);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('capture');

  const [rows, setRows] = useState<CaptureRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [detail, setDetail] = useState<{ capture: CaptureRow; documentId: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState<'vendor_bill' | 'expense_line'>('vendor_bill');
  const [busy, setBusy] = useState(false);
  // F-03 (J3.1): the two pickers the commit needs, and the ledger they pick from.
  const [accounts, setAccounts] = useState<{ id: string; number: string; name: string }[]>([]);
  const [vendors, setVendors] = useState<ComboboxOption[]>([]);
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [vendorId, setVendorId] = useState('');
  // Critic F3: the purchase-side tax codes (null until `vat_codes` answered), the choice the act will
  // send, and the capture a person chose the code for by hand (a hand-picked code is never re-defaulted).
  const [taxCodes, setTaxCodes] = useState<PurchaseTaxCode[] | null>(null);
  const [taxChoice, setTaxChoice] = useState('');
  const taxHandPicked = useRef<string | null>(null);
  const usualCache = useRef(new Map<string, Promise<VendorUsual>>());
  // The Commit moment (D122 D-I): the queue row the commit just moved to "Übernommen" lands with
  // the decaying tint once the queue has refetched.
  const [justCommittedId, setJustCommittedId] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ captureId: string; billId: string; posted: boolean } | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);
    const response = await client.call('list_captures', { workspaceId });
    if (isErr(response.body)) {
      if (response.body.error === 'permission_denied' || response.status === 403) setDenied(true);
      else setError(response.body);
      setLoading(false);
      return;
    }
    setRows((response.body as { captures?: CaptureRow[] }).captures ?? []);
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The pickers' sources, read once per workspace. Supplementary reads: a failure narrows to an empty
  // picker (the engine's needs_account / needs_vendor still names the gap), never to a dead surface.
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void (async () => {
      const [acc, con, vat] = await Promise.all([
        client.call('list_accounts', { workspaceId }),
        client.call('list_contacts', { workspaceId }),
        client.call('vat_codes', { workspaceId }),
      ]);
      if (!live) return;
      // No codes (MWST not configured, or the read refused) means the bill books without VAT, stated.
      const codes = isErr(vat.body)
        ? []
        : ((vat.body as { taxCodes?: { code: string; kind: string; rateBp?: number; label?: string | null; active?: boolean }[] }).taxCodes ?? [])
            .filter((c) => c.active !== false && PURCHASE_TAX_KINDS.includes(c.kind))
            .map((c) => ({ code: c.code, kind: c.kind, rateBp: typeof c.rateBp === 'number' ? c.rateBp : 0, label: c.label ?? null }));
      setTaxCodes(codes);
      if (!isErr(acc.body)) {
        const rows = ((acc.body as { accounts?: { id: string; number: string; name: string; archived?: boolean }[] }).accounts ?? [])
          .filter((a) => a.archived !== true)
          .map((a) => ({ id: a.id, number: a.number, name: a.name }));
        setAccounts(rows);
      }
      if (!isErr(con.body)) {
        const rows = ((con.body as { contacts?: { id: string; name: string; partyRole?: string }[] }).contacts ?? [])
          .filter((c) => c.partyRole === 'vendor' || c.partyRole === 'both')
          .map((c) => ({ id: c.id, label: c.name }));
        setVendors(rows);
      }
    })();
    usualCache.current.clear();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  /**
   * What the vendor was booked with last time (J3.1 step 2: "the expense account defaults to the
   * vendor's last one", and critic F3: the code too). ONE `list_vendor_bills` read filtered to the
   * vendor, newest bill date first, cached per vendor while the surface lives: the account comes off
   * the newest bill, the code off the newest POSTED bill (a draft's code is not yet a decision).
   */
  const usualFor = useCallback(
    (vendor: string): Promise<VendorUsual> => {
      const cached = usualCache.current.get(vendor);
      if (cached !== undefined) return cached;
      const pending = (async (): Promise<VendorUsual> => {
        const response = await client.call('list_vendor_bills', { workspaceId, vendorId: vendor });
        if (isErr(response.body)) return { accountId: null, taxCode: undefined };
        type Bill = { billDate?: string; expenseAccountId?: string; createdAt?: string; status?: string; taxCode?: string | null };
        const bills = [...((response.body as { bills?: Bill[] }).bills ?? [])].sort((a, b) =>
          `${b.billDate ?? ''}${b.createdAt ?? ''}`.localeCompare(`${a.billDate ?? ''}${a.createdAt ?? ''}`),
        );
        const newest = bills[0];
        const newestPosted = bills.find((b) => b.status === 'posted');
        return {
          accountId: typeof newest?.expenseAccountId === 'string' && newest.expenseAccountId !== '' ? newest.expenseAccountId : null,
          taxCode: newestPosted === undefined ? undefined : typeof newestPosted.taxCode === 'string' && newestPosted.taxCode !== '' ? newestPosted.taxCode : null,
        };
      })();
      usualCache.current.set(vendor, pending);
      return pending;
    },
    [client, workspaceId],
  );
  const lastAccountFor = useCallback(async (vendor: string) => (await usualFor(vendor)).accountId, [usualFor]);

  /**
   * The code the act will post with, or '' when the person has to say (critic F3). In order: no codes
   * at all books without VAT; the vendor's newest posted bill's code (its "none" included); the ONE
   * active input code whose effective rate on the invoice date equals the capture's Swico rate, read
   * through `vat_preview` so the engine resolves the rate (a zero-rate seed code like VST-M means the
   * Normalsatz of the supply date, and that arithmetic stays the engine's); else nothing.
   */
  const defaultTaxFor = useCallback(
    async (vendor: string, fields: readonly CaptureField[]): Promise<string> => {
      if (taxCodes === null) return '';
      if (taxCodes.length === 0) return TAX_NONE;
      if (vendor !== '') {
        const usual = await usualFor(vendor);
        if (usual.taxCode === null) return TAX_NONE;
        if (typeof usual.taxCode === 'string' && taxCodes.some((c) => c.code === usual.taxCode)) return usual.taxCode;
      }
      const live = (key: string) => fields.find((f) => f.key === key && !f.superseded)?.value;
      const wantBp = rateToBp(live('vat_rate'));
      if (wantBp === null) return '';
      const supplyDate = typeof live('invoice_date') === 'string' ? (live('invoice_date') as string) : undefined;
      const inputs = taxCodes.filter((c) => c.kind === 'input');
      const rates = await Promise.all(
        inputs.map(async (c) => {
          const preview = await client.call('vat_preview', {
            workspaceId,
            amountMinor: 10000,
            amountIsGross: false,
            taxCode: c.code,
            ...(supplyDate !== undefined ? { supplyDate } : {}),
          });
          return isErr(preview.body) ? null : (preview.body as { rateBp?: number }).rateBp ?? null;
        }),
      );
      const matches = inputs.filter((_, i) => rates[i] === wantBp);
      const only = matches[0];
      return matches.length === 1 && only !== undefined ? only.code : '';
    },
    [client, workspaceId, taxCodes, usualFor],
  );

  const loadDetail = useCallback(
    async (captureId: string) => {
      const response = await client.call('get_capture', { workspaceId, captureId });
      if (isErr(response.body)) {
        setDetail(null);
        return;
      }
      const body = response.body as unknown as { capture: CaptureRow; fields: CaptureField[]; documentId: string };
      setDetail({ capture: { ...body.capture, fields: body.fields }, documentId: body.documentId });
      const dt = body.fields.find((f) => f.key === 'doc_type' && !f.superseded);
      if (dt?.value === 'expense') setTarget('expense_line');
      // Seed the two pickers from the proposal: the matched vendor, the proposed account, and when
      // no account was proposed, the vendor's last one.
      const live = (key: string) => body.fields.find((f) => f.key === key && !f.superseded)?.value;
      const proposedVendor = typeof live('vendor_contact_id') === 'string' ? (live('vendor_contact_id') as string) : '';
      const proposedAccount = typeof live('expense_account_id') === 'string' ? (live('expense_account_id') as string) : '';
      setVendorId(proposedVendor);
      if (taxHandPicked.current !== body.capture.id) {
        taxHandPicked.current = null;
        setTaxChoice('');
      }
      if (proposedAccount !== '') setExpenseAccountId(proposedAccount);
      else if (proposedVendor !== '') setExpenseAccountId((await lastAccountFor(proposedVendor)) ?? '');
      else setExpenseAccountId('');
    },
    [client, workspaceId, lastAccountFor],
  );

  // Critic F3: the code follows the vendor and the capture until a person picks it by hand for THIS
  // capture. Re-resolved whenever the vendor or the code list changes.
  useEffect(() => {
    if (detail === null || detail.capture.status !== 'needs_review' || taxCodes === null) return;
    const captureId = detail.capture.id;
    if (taxHandPicked.current === captureId) return;
    let live = true;
    void (async () => {
      const code = await defaultTaxFor(vendorId, detail.capture.fields ?? []);
      if (live && taxHandPicked.current !== captureId) setTaxChoice(code);
    })();
    return () => {
      live = false;
    };
  }, [detail, vendorId, taxCodes, defaultTaxFor]);

  // A vendor picked by hand brings its last account along, unless an account is already chosen.
  const onPickVendor = useCallback(
    async (id: string) => {
      setVendorId(id);
      if (id === '' || expenseAccountId !== '') return;
      const last = await lastAccountFor(id);
      if (last !== null) setExpenseAccountId(last);
    },
    [expenseAccountId, lastAccountFor],
  );

  useEffect(() => {
    if (selectedId !== null) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id === null) next.delete('capture');
      else next.set('capture', id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const onDrop = useCallback(
    async (file: File) => {
      if (workspaceId === null) return;
      setBusy(true);
      setNotice(null);
      try {
        const contentBase64 = await fileToBase64(file);
        const response = await client.call('capture_document', {
          workspaceId,
          contentBase64,
          mime: file.type || 'application/pdf',
          filename: file.name,
          idempotencyKey: newKey(),
        });
        if (isErr(response.body)) {
          setNotice(t(`capture.error.${response.body.error}`));
          return;
        }
        const body = response.body as unknown as { captureId: string; duplicate: boolean };
        if (body.duplicate) setNotice(t('capture.duplicate'));
        await load();
        select(body.captureId);
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, load, select, t],
  );

  const liveFields = useMemo(
    () => (detail?.capture.fields ?? []).filter((f) => !f.superseded && f.key !== 'doc_type'),
    [detail],
  );

  const onCommit = useCallback(async () => {
    if (detail === null || workspaceId === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const captureId = detail.capture.id;
      const response = await client.call('capture_commit', {
        workspaceId,
        captureId,
        target: {
          kind: target,
          ...(target === 'vendor_bill' && vendorId !== '' ? { vendorId } : {}),
          ...(expenseAccountId !== '' ? { expenseAccountId } : {}),
          // The decided Vorsteuer: a code, or null for a bill that carries no VAT. Never absent on the
          // bill path, so the engine's fall-back to a field the capture never proposes is never taken.
          ...(target === 'vendor_bill' && taxChoice !== '' ? { taxCode: taxChoice === TAX_NONE ? null : taxChoice } : {}),
        },
        // Keyed on the capture, so a double press (or a retry after a refused post) replays the
        // commit and gets the ORIGINAL target back instead of a second draft.
        idempotencyKey: `capture-commit:${captureId}`,
      });
      if (isErr(response.body)) {
        setNotice(t(`capture.error.${response.body.error}`));
        return;
      }
      const body = response.body as unknown as { targetKind: string; targetId: string };
      let didPost = false;
      if (body.targetKind === 'vendor_bill' && canCommitBill) {
        // The second half of the one act: A17's own posting verb, its own key, keyed on the capture
        // as well so a replay of the same act never posts twice.
        const post = await client.call('post_vendor_bill', {
          workspaceId,
          vendorBillId: body.targetId,
          idempotencyKey: `capture-post:${captureId}`,
        });
        if (isErr(post.body)) {
          setNotice(t('capture.postRefused'));
        } else didPost = (post.body as { status?: string }).status !== 'pending';
      }
      // The act just wrote the vendor's newest bill, so what "usual" means for this vendor changed:
      // drop the cached read so the vendor's next capture in this session defaults to the account
      // and code that were just posted (re-critic R2).
      if (vendorId !== '') usualCache.current.delete(vendorId);
      setPosted({ captureId, billId: body.targetId, posted: didPost });
      setJustCommittedId(captureId);
      await load();
      await loadDetail(captureId);
    } finally {
      setBusy(false);
    }
  }, [client, detail, workspaceId, target, vendorId, expenseAccountId, taxChoice, canCommitBill, load, loadDetail, t]);

  const onDiscard = useCallback(
    async (captureId: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      try {
        await client.call('capture_discard', { workspaceId, captureId, idempotencyKey: newKey() });
        await load();
        if (selectedId === captureId) select(null);
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, load, selectedId, select],
  );

  useCommitAck(justCommittedId, rows);

  const columns: DataTableColumn<CaptureRow>[] = useMemo(
    () => [
      {
        key: 'createdAt',
        header: t('capture.col.received'),
        render: (row) => <span className="t-num">{formatDate(row.createdAt.slice(0, 10))}</span>,
      },
      {
        key: 'status',
        header: t('capture.col.status'),
        render: (row) => <Status kind={captureStatusKind(row.status)} label={t(`capture.status.${row.status}`)} />,
      },
      {
        key: 'actions',
        header: t('capture.action.more'),
        headerHidden: true,
        align: 'end',
        render: (row) =>
          row.status === 'needs_review' ? (
            // Stop the row-open click from firing when the menu trigger is used: the overflow is an
            // independent affordance living inside a clickable row.
            <span className="capture__rowActions" onClick={(e) => e.stopPropagation()}>
              <OverflowMenu
                label={t('capture.action.more')}
                items={[
                  { key: 'discard', label: t('capture.action.discard'), onSelect: () => void onDiscard(row.id), danger: true },
                ]}
              />
            </span>
          ) : null,
      },
    ],
    [t, onDiscard],
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied title={t('capture.route.title')} />;

  // K-13: the shared FileDrop in the header slot, the Studio's own "Beleg wählen" button, never the
  // browser's English "Choose File / No file chosen" in Arial.
  const dropAction = canDrop ? (
    <FileDrop
      variant="button"
      label={t('capture.action.choose')}
      disabled={busy}
      onFiles={(files) => {
        const file = files[0];
        if (file !== undefined) void onDrop(file);
      }}
    />
  ) : undefined;

  return (
    <section className="capture" aria-labelledby="capture-title">
      <SurfaceHeader
        title={t('capture.route.title')}
        titleId="capture-title"
        help={<SurfaceHelp surface="Capture" />}
        actions={dropAction}
      />

      {notice !== null ? (
        <p className="capture__notice" role="status">
          {notice}
        </p>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        caption={t('capture.route.title')}
        loading={loading}
        error={error ?? undefined}
        onRetry={() => void load()}
        skeletonRows={4}
        onRowClick={(row) => select(row.id)}
        rowLabel={(row) => `${formatDate(row.createdAt.slice(0, 10))}, ${t(`capture.status.${row.status}`)}`}
        // K-24: the record open in the drawer is the current row (the selection pill), not a local
        // class with its own fill.
        isRowCurrent={(row) => row.id === selectedId}
        rowClassName={(row) => (row.id === justCommittedId ? COMMIT_TARGET_CLASS : undefined)}
        emptyState={<EmptyState title={t('capture.empty.queue')} hint={t('capture.empty.queueHint')} />}
      />

      {detail !== null ? (
        <DetailDrawer
          open
          onClose={() => select(null)}
          title={t('capture.review.title')}
          closeLabel={t('capture.action.back')}
          headerExtra={
            <Status
              kind={captureStatusKind(detail.capture.status)}
              label={t(`capture.status.${detail.capture.status}`)}
            />
          }
          footer={
            detail.capture.status === 'needs_review' ? (
              // K-08: the shared button ladder. Taking the bill over AND posting it is the commit of a
              // money write, so the tinted money-commit button under the consequence line above;
              // taking it over as a draft is the drawer's plain primary.
              <button
                type="button"
                className={target === 'vendor_bill' && canCommitBill ? 'btn btn--accent' : 'btn btn--primary'}
                data-money-commit={target === 'vendor_bill' && canCommitBill ? 'post_vendor_bill' : undefined}
                disabled={busy || (target === 'vendor_bill' && (!canCommitBill || vendorId === '' || expenseAccountId === '' || taxChoice === ''))}
                title={target === 'vendor_bill' && !canCommitBill ? t('capture.commit.requires') : undefined}
                onClick={() => void onCommit()}
              >
                {target === 'vendor_bill' && canCommitBill ? t('capture.action.commitAndPost') : t('capture.action.commit')}
              </button>
            ) : undefined
          }
        >
          <p className="capture__docref">
            {t('capture.original.ref')}: {detail.documentId}
          </p>

          <div className="capture__fields">
            {liveFields.length === 0 ? (
              <EmptyState
                title={t('capture.empty.fields')}
                hint={detail.capture.qrPresent ? t('capture.empty.fieldsHintManual') : t('capture.empty.fieldsHintNoqr')}
              />
            ) : (
              <table>
                <tbody>
                  {liveFields.map((f) => (
                    <tr key={f.key}>
                      <th scope="row">{t(`capture.field.${f.key}`)}</th>
                      <td className={isMoneyValue(f) ? 'capture__val t-money' : 'capture__val'}>{renderValue(f)}</td>
                      <td>
                        <span className="capture__prov" aria-label={t(`capture.provenance.${f.provenance}`)}>
                          {t(`capture.provenance.${f.provenance}`)}
                        </span>{' '}
                        <span className="capture__conf">{t(`capture.confidence.${f.confidence}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {detail.capture.status === 'needs_review' ? (
            <>
              <fieldset className="capture__target">
                <legend>{t('capture.target.legend')}</legend>
                <label>
                  <input type="radio" name="target" checked={target === 'vendor_bill'} onChange={() => setTarget('vendor_bill')} />
                  {t('capture.target.bill')}
                </label>
                <label>
                  <input type="radio" name="target" checked={target === 'expense_line'} onChange={() => setTarget('expense_line')} />
                  {t('capture.target.expense')}
                </label>
              </fieldset>
              {/* F-03 (J3.1): the two answers the commit needs, asked HERE rather than refused after
                  the press. The vendor picker appears only when no vendor matched; the account is
                  pre-filled from the vendor's last bill and typeable by number. */}
              {target === 'vendor_bill' && (
                <div className="capture__pickers">
                  {vendorId === '' && (
                    <label className="capture__picker" htmlFor="capture-vendor">
                      <span>{t('capture.pick.vendor')}</span>
                      <Combobox
                        id="capture-vendor"
                        ariaLabel={t('capture.pick.vendor')}
                        options={vendors}
                        value={vendorId}
                        onChange={(id) => void onPickVendor(id)}
                        placeholder={t('capture.pick.vendorPlaceholder')}
                        noMatchLabel={t('capture.pick.noVendor')}
                      />
                    </label>
                  )}
                  <label className="capture__picker" htmlFor="capture-account">
                    <span>{t('capture.pick.account')}</span>
                    <AccountCombobox
                      id="capture-account"
                      ariaLabel={t('capture.pick.account')}
                      accounts={accounts}
                      value={expenseAccountId}
                      onChange={setExpenseAccountId}
                      placeholder={t('capture.pick.accountPlaceholder')}
                      noMatchLabel={t('capture.pick.noAccount')}
                    />
                  </label>
                  {/* Critic F3: the Vorsteuer, decided here and named below, never defaulted to nothing.
                      With no purchase codes at all there is nothing to pick and the bill books without
                      VAT, which the sentence states. */}
                  {taxCodes !== null && taxCodes.length > 0 && (
                    <div className="capture__picker">
                      <span>{t('capture.pick.tax')}</span>
                      <Select
                        id="capture-tax"
                        value={taxChoice}
                        onChange={(value) => {
                          taxHandPicked.current = detail.capture.id;
                          setTaxChoice(value);
                        }}
                        options={[
                          { value: '', label: t('capture.pick.taxChoose') },
                          { value: TAX_NONE, label: t('capture.pick.taxNone') },
                          ...taxCodes.map((c) => ({
                            value: c.code,
                            label: c.label !== null && c.label !== '' ? `${c.code}, ${c.label}` : c.code,
                          })),
                        ]}
                        ariaLabel={t('capture.pick.tax')}
                      />
                    </div>
                  )}
                  {canCommitBill && (
                    <p className="capture__consequence">
                      {taxChoice === ''
                        ? t('capture.commit.consequenceNeedsTax')
                        : taxChoice === TAX_NONE
                          ? t('capture.commit.consequenceNoTax')
                          : t('capture.commit.consequenceWithTax', { code: taxChoice })}
                    </p>
                  )}
                  {canCommitBill && <ConsequenceLine verb="post_vendor_bill" />}
                </div>
              )}
            </>
          ) : (
            <p className="capture__committed" role="status">
              {posted !== null && posted.captureId === detail.capture.id && detail.capture.targetKind === 'vendor_bill'
                ? t(posted.posted ? 'capture.committed.posted' : 'capture.committed.drafted')
                : t(`capture.status.${detail.capture.status}`)}
              {detail.capture.targetKind === 'vendor_bill' && detail.capture.targetId !== null ? (
                <>
                  {' '}
                  <Link className="link-inline" to={`/bills?bill=${encodeURIComponent(detail.capture.targetId)}`}>{t('capture.committed.openBill')}</Link>
                </>
              ) : detail.capture.targetId !== null ? (
                `: ${detail.capture.targetId}`
              ) : (
                ''
              )}
            </p>
          )}
        </DetailDrawer>
      ) : null}
    </section>
  );
}
