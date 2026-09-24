/**
 * D-S4, the "Aufteilung nach Fälligkeit anpassen" popover: the one write A16 performs.
 *
 * THE FILE AND THE ENGINE STILL SAY "BUCKET", THE SCREEN NEVER DOES. `set_aging_bucket_config` is
 * the engine's verb and renaming the code to match the copy would break the only name the API has.
 * On screen the control is named after the thing it changes, which the tile group already calls
 * "Aufteilung nach Fälligkeit": a menu item reading "Bucket-Grenzen" gave the same object two names
 * on one surface, one of them a coined English word an operator has no reason to look under.
 *
 * THE SENTENCE THAT HAS TO BE THERE, AND THE WORDS THAT MUST NEVER BE. OR's bookkeeping articles
 * (957 ff.) prescribe no receivables aging at all: [30, 60, 90] is a DACH reporting convention and
 * nothing more, and the engine says so in its own header. Verzug is a different legal fact, OR
 * Art. 102 governs when it begins and Art. 104 Abs. 1 sets Verzugszins at five per cent a year, and
 * both belong to A15, which is unbuilt. So a "31 bis 60" tile never means "in Verzug", the popover
 * carries one line saying this is a view and not a deadline, and the words Verzug, Mahnfrist,
 * Mahnung and Verzugszins appear nowhere on this surface in any state.
 *
 * THE BOUNDARY COUNT IS CAPPED AT FIVE, AND THE CAP IS THE HICK NUMBER. `validateBoundaries` in the
 * engine enforces strictly increasing positive integers and imposes NO upper limit, and the tile
 * count is `boundaries.length + 1`, so six boundaries would give seven tiles plus "Alle anzeigen" and
 * blow the ceiling. The fix is prevention at the control rather than a bigger number: "Grenze
 * hinzufügen" disables at five with the reason inline, which holds this popover at seven choices and
 * the tile group at seven, and costs a real workspace nothing, because nobody ages receivables into
 * seven bands.
 *
 * SAVE IS DISABLED AT ZERO BOUNDARIES rather than submitted and rejected, and for the same reason
 * it is disabled on any list the engine would refuse: an unfilled field and a non-increasing pair
 * are both client-side facts. The first build computed `complete` and spent it only on the preview,
 * so pressing "Grenze hinzufügen" and then Speichern sent `null` and earned a sentence about
 * positive whole numbers for a field the operator simply had not filled in yet. Every reason is on
 * screen: the order error beside the field that breaks it, the rest beside the disabled button.
 *
 * IDEMPOTENCY, INVISIBLY, AND KEYED ON THE LIST RATHER THAN ON THE OPEN. `set_aging_bucket_config`
 * requires a key, and the key cannot live on the config row, because `workspace_id` is that row's
 * primary key and the write replaces it in place, so a late retry of an older key would otherwise be
 * unrecognisable as a replay and would silently roll a newer edit back. That reasoning is the
 * engine's and it still holds.
 *
 * What did NOT hold was minting the key when the popover OPENS. It then named one save attempt for
 * the whole open while the fields behind it stayed editable, and the engine fingerprints no input at
 * all, so a retry of a CHANGED list was answered with the FIRST list and this popover closed
 * reporting a success on a cut the operator had already typed away. The key is derived from the
 * boundaries instead: one key per list, a new one when the list changes, and an unchanged list
 * re-saved after a lost response still one write.
 *
 * THE "ERGIBT" LINE is a live preview of the labels the current fields would produce. It is the
 * recognition-over-recall answer to a set of bare day counts: the operator sees the buckets rather
 * than computing them.
 *
 * IT IS A POPOVER AND NOT A DRAWER, and the difference is enforced here rather than described. The
 * panel is rendered by the caller inside the element that holds the header overflow, and
 * `.oi-popover` is absolutely positioned against it, so it opens under the control that summoned it
 * instead of at the bottom of the surface. The first build rendered it as the last child of the
 * surface in normal flow with no `position` at all, which put it below the tiles and below the whole
 * table: the operator pressed the one write control A16 owns and nothing visibly happened.
 *
 * NO SCRIM, NO `aria-modal`, NO FOCUS TRAP, and that is the popover's contract rather than an
 * omission. A modal shell is what `BankAccountEditor`'s drawer is for, and borrowing it here would
 * dim a surface the operator is reading to change how it is cut. What a popover does owe is the
 * three things this one now does: it takes focus on open, it returns focus to the trigger on close,
 * and it dismisses on Escape and on a press outside. That matches `HelpHint`, which is this repo's
 * other popover, rather than inventing a third dismissal vocabulary.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { Skeleton } from '../../components/states';
import { bucketLabel, boundaryErrorKey, parseBucketConfig, MAX_BOUNDARIES } from './model';

export interface BucketBoundariesProps {
  onClose: () => void;
  /** Called after a successful write, so the caller re-reads and the tiles re-partition in place. */
  onSaved: () => void;
}

export function BucketBoundaries({ onClose, onSaved }: BucketBoundariesProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [readError, setReadError] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  // Focus goes back where it came from. `OverflowMenu.selectItem` hands focus to its trigger BEFORE
  // running the action, so the element captured here is that trigger and not the menu item, which
  // is already gone by the time this unmounts.
  //
  // THIS EFFECT IS DECLARED BEFORE THE ONE BELOW ON PURPOSE: effects run in declaration order, so
  // capturing after the heading has taken focus would capture the heading and "restore" focus to a
  // node that is being removed.
  useEffect(() => {
    const returnTo = document.activeElement;
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, []);

  // Focus lands on the heading rather than the first field, because the first field does not exist
  // while the config read is still in flight, and a panel that announces nothing on open is the
  // half of F1 a screen-reader user gets instead of the wrong-place half.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Escape, and a press outside. `mousedown` rather than `click`, so the panel is gone before the
  // click lands on whatever was underneath it, which is the convention `OverflowMenu` already sets.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const panel = panelRef.current;
      if (panel !== null && !panel.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (workspaceId === null) {
        setLoading(false);
        return;
      }
      const response = await client.call('get_aging_bucket_config', { workspaceId });
      if (cancelled) return;
      if (isErr(response.body)) {
        setReadError(true);
        setLoading(false);
        return;
      }
      const config = parseBucketConfig(response.body);
      if (config === null) {
        setReadError(true);
        setLoading(false);
        return;
      }
      setValues(config.boundariesDays.map((n) => String(n)));
      setConfigured(config.configured);
      setLoading(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  const parsed = values.map((value) => Number.parseInt(value, 10));
  const complete = values.length > 0 && parsed.every((n) => Number.isSafeInteger(n) && n > 0);

  /**
   * ONE key per LIST, and a new one the moment the list changes (see the header's IDEMPOTENCY note).
   *
   * It was minted once per open and held for the whole open, which is right for a retry of the same
   * list and silently wrong for a retry of a CHANGED one. `setAgingBucketConfig` fingerprints
   * nothing whatsoever: `recallIdempotent(workspaceId, key, 'set_aging_bucket_config')` runs before
   * the boundaries are even validated, and the replay is byte-identical by design, carrying no
   * marker a caller could notice. So an edited list under a held key is answered with the FIRST
   * list, this popover calls `onSaved()` and closes, and the operator is told the cut they typed was
   * saved while the tiles re-partition to the cut they typed away. The window is the one the key
   * exists for: a write that landed whose response was lost, which the client sees as a
   * `transport_error` refusal over fields it has deliberately kept intact.
   *
   * Derived from `parsed` and NOT from `values`, because `parsed` is what the write sends. Deriving
   * it from the raw strings would re-mint on "15" becoming " 15", an edit the engine never sees,
   * and throwing a key away for an unchanged request is the double-write the key exists to prevent.
   *
   * The engine's reason for holding the key in the side table rather than on the config row is
   * untouched: an out-of-order retry of an OLDER list still carries that list's own key, so it still
   * replays its own answer instead of rolling a newer edit back.
   */
  const idempotencyKey = useIdempotencyKey(parsed);

  /**
   * The first field that is not greater than the one before it, or -1.
   *
   * Three lines of arithmetic the client can run, so the engine is never asked to refuse it. Only
   * meaningful once every field parses, which is why it is guarded on `complete`: a half-typed list
   * is incomplete rather than out of order, and saying "must be greater than the one before" about
   * a field nobody has filled in yet would be the same wasted round trip in a nicer costume.
   */
  const outOfOrderAt = complete
    ? parsed.findIndex((n, index) => index > 0 && n <= (parsed[index - 1] ?? 0))
    : -1;

  /** Save is off unless the whole list would be accepted. Prevention at the control, not a refusal. */
  const submittable = complete && outOfOrderAt === -1;

  // The preview follows `submittable` and not `complete`: previewing "31 bis 20 Tage" would show
  // the operator a bucket that cannot exist.
  const preview = submittable
    ? [...parsed, 0].map((_, index) => {
        const label = bucketLabel(parsed, index);
        return t(label.key, label.params);
      })
    : [];

  const save = useCallback(async () => {
    if (workspaceId === null) return;
    setSaving(true);
    setWriteError(null);
    const response = await client.call('set_aging_bucket_config', {
      workspaceId,
      // The same array the key was derived from, so the fingerprint and the payload cannot drift.
      boundariesDays: parsed,
      idempotencyKey,
    });
    setSaving(false);
    if (isErr(response.body)) {
      // Every typed value survives: the popover stays open with the fields exactly as entered.
      setWriteError(response.body);
      return;
    }
    onSaved();
  }, [client, workspaceId, parsed, idempotencyKey, onSaved]);

  const atCap = values.length >= MAX_BOUNDARIES;

  return (
    <div
      className="oi-popover panel panel--pad"
      role="dialog"
      aria-label={t('openItems.editBoundaries')}
      ref={panelRef}
    >
      {/* `tabIndex={-1}`: a focus target, never a tab stop. The panel's name is announced on open
          without adding a stop to the surface's tab order. */}
      <h2 className="oi-popover-title" tabIndex={-1} ref={titleRef}>
        {t('openItems.editBoundaries')}
      </h2>

      {loading ? (
        <Skeleton rows={3} />
      ) : readError ? (
        <p className="field-error" role="alert">
          {t('openItems.error.transport')}
        </p>
      ) : (
        <>
          <p className="oi-popover-source">
            {configured ? t('openItems.boundaries.chosen') : t('openItems.boundaries.default')}
          </p>

          <div className="form-stack">
            {values.map((value, index) => (
              <div className="form-row oi-boundary-row" key={`boundary-${index}`}>
                <label className="field-label-row" htmlFor={`oi-boundary-${index}`}>
                  {t('openItems.boundaries.field', { n: index + 1 })}
                </label>
                <input
                  id={`oi-boundary-${index}`}
                  className="field oi-boundary-input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  aria-invalid={index === outOfOrderAt ? true : undefined}
                  aria-describedby={index === outOfOrderAt ? `oi-boundary-${index}-error` : undefined}
                  value={value}
                  onChange={(event) => {
                    const next = [...values];
                    next[index] = event.target.value;
                    setValues(next);
                  }}
                />
                <span className="oi-boundary-unit">{t('openItems.boundaries.days')}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setValues(values.filter((_, i) => i !== index))}
                >
                  {t('openItems.boundaries.remove', { n: index + 1 })}
                </button>
                {/* Beside the field it is about, never at the bottom of the panel. */}
                {index === outOfOrderAt && (
                  <span className="field-error" id={`oi-boundary-${index}-error`}>
                    {t('openItems.error.boundaries.increasing')}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="oi-boundary-add">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={atCap}
              onClick={() => setValues([...values, ''])}
            >
              {t('openItems.boundaries.add')}
            </button>
            {/* D15/C3: the reason for a disabled control is on screen, never hover-only. */}
            {atCap && <span className="field-hint">{t('openItems.error.boundaries.max')}</span>}
          </div>

          {preview.length > 0 && (
            <p className="oi-popover-preview">
              {t('openItems.boundaries.preview', { buckets: preview.join(', ') })}
            </p>
          )}

          <p className="oi-popover-note">{t('openItems.boundaries.note')}</p>

          {writeError !== null && (
            <p className="field-error" role="alert">
              {writeError.error === 'invalid_input'
                ? t(boundaryErrorKey(writeError.expected))
                : writeError.error === 'permission_denied'
                  ? t('openItems.error.permissionDenied.write')
                  : t('errors.fallback')}
            </p>
          )}

          {/* D15/C3 again: a disabled Save says why on screen. `increasing` is not repeated here,
              because it is already rendered beside the field it belongs to. */}
          {!complete && (
            <p className="field-hint">
              {t(
                values.length === 0
                  ? 'openItems.error.boundaries.empty'
                  : 'openItems.error.boundaries.positive',
              )}
            </p>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              {t('openItems.boundaries.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!submittable || saving}
              onClick={() => void save()}
            >
              {t('openItems.boundaries.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
