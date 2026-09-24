/**
 * FileDrop: the one way to hand the Studio a file (K-13, D137).
 *
 * A bare `<input type="file">` renders the browser's own control: Arial, a 1990s inset button and
 * ENGLISH copy ("Choose File / No file chosen") in the middle of a de-CH surface, measured live on the
 * Belegeingang. Files and Migration had each hand-rolled a proxy around a hidden input; this is that
 * proxy, once.
 *
 * What it settles:
 *   - **The real input stays, and it is the keyboard target.** It is visually hidden (clipped, never
 *     `display: none`), so it keeps its native semantics: a screen reader announces a file upload
 *     button, Enter and Space open the picker, and its name is the visible button text because the
 *     label wraps it. The visible button draws the focus ring when the hidden input holds focus.
 *   - **The button speaks the product's language** ("Datei wählen"), in Inter, as a `.btn--secondary`.
 *   - **Dropping is an extra, never the only way** (WCAG 2.5.7's spirit: no path needs a drag). The
 *     `zone` variant is a drop target around the button; the `button` variant is the button alone, for
 *     a header action slot.
 *   - **`accept` holds for dropped files too.** The picker filters by `accept`, a drop does not, so
 *     dropped files are checked here and the ones that do not match go to `onReject` instead of
 *     `onFiles`. A drop of only wrong files never reaches the caller's upload.
 *
 * Stateless: every pick or drop calls `onFiles` with the files and resets the input, so picking the
 * same file twice still fires. The caller owns progress and errors.
 */
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';

import { useT } from '../i18n';
import { UploadGlyph } from './icons';
import './FileDrop.css';

export type FileDropVariant = 'zone' | 'button';

export interface FileDropProps {
  /** Called with the picked or dropped files that match `accept`. Never called with an empty list. */
  onFiles: (files: File[]) => void;
  /** Called with dropped files that do NOT match `accept`, so the caller can say why nothing happened. */
  onReject?: (files: File[]) => void;
  /** The native `accept` list: extensions (`.pdf`) and MIME types (`image/*`, `application/xml`). */
  accept?: string;
  /** Allow several files at once. */
  multiple?: boolean;
  /** Disable the picker and the drop target. */
  disabled?: boolean;
  /**
   * The button text, and so the input's accessible name. Defaults to "Datei wählen" (or "Dateien
   * wählen" when `multiple`).
   */
  label?: string;
  /**
   * The line beside the button in the zone variant. Defaults to "Datei hierher ziehen" (or the
   * plural). Ignored by the button variant, which has no zone to drop onto.
   */
  prompt?: string;
  /** A quiet second line: the accepted types or a size limit. Wired as the input's description. */
  hint?: ReactNode;
  /** A drop zone around the button (default), or the button alone. */
  variant?: FileDropVariant;
  /** An id for the real input, so a surrounding `<label htmlFor>` or a test can reach it. */
  id?: string;
  /** An extra class on the root, for layout only. */
  className?: string;
}

/** One `accept` token against one file: `.ext`, `type/*` or an exact MIME type. */
function matchesToken(file: File, token: string): boolean {
  const want = token.trim().toLowerCase();
  if (want === '') return false;
  if (want.startsWith('.')) return file.name.toLowerCase().endsWith(want);
  const type = file.type.toLowerCase();
  if (want.endsWith('/*')) return type.startsWith(want.slice(0, -1));
  return type === want;
}

/** Whether `file` satisfies an `accept` list. No list accepts everything, as the picker does. */
export function matchesAccept(file: File, accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') return true;
  return accept.split(',').some((token) => matchesToken(file, token));
}

export function FileDrop({
  onFiles,
  onReject,
  accept,
  multiple = false,
  disabled = false,
  label,
  prompt,
  hint,
  variant = 'zone',
  id,
  className,
}: FileDropProps) {
  const t = useT();
  const generatedId = useId();
  const inputId = id ?? `${generatedId}-input`;
  const hintId = `${generatedId}-hint`;
  // dragenter/dragleave fire for every child the pointer crosses, so a plain boolean flickers. Count
  // the enters and leaves instead; the zone is "over" while the count is above zero.
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const buttonText = label ?? t(multiple ? 'fileDrop.chooseMany' : 'fileDrop.choose');
  const promptText = prompt ?? t(multiple ? 'fileDrop.promptMany' : 'fileDrop.prompt');

  const deliver = (list: FileList | null, fromDrop: boolean) => {
    if (list === null || list.length === 0) return;
    const all = Array.from(list);
    const offered = multiple ? all : all.slice(0, 1);
    // The picker has already applied `accept`; a drop has not, so only a drop is filtered here.
    const accepted = fromDrop ? offered.filter((file) => matchesAccept(file, accept)) : offered;
    const rejected = fromDrop ? offered.filter((file) => !matchesAccept(file, accept)) : [];
    if (accepted.length > 0) onFiles(accepted);
    if (rejected.length > 0) onReject?.(rejected);
  };

  const button = (
    <label
      className={`btn btn--secondary file-drop-button${disabled ? ' is-disabled' : ''}`}
      htmlFor={inputId}
    >
      <input
        id={inputId}
        type="file"
        className="file-drop-input"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-describedby={hint !== undefined ? hintId : undefined}
        onChange={(event) => {
          deliver(event.target.files, false);
          // Reset, so picking the same file again is a change and fires again.
          event.target.value = '';
        }}
      />
      {buttonText}
    </label>
  );

  const hintNode =
    hint !== undefined ? (
      <span id={hintId} className="file-drop-hint">
        {hint}
      </span>
    ) : null;

  if (variant === 'button') {
    return (
      <span className={className === undefined ? 'file-drop file-drop--button' : `file-drop file-drop--button ${className}`}>
        {button}
        {hintNode}
      </span>
    );
  }

  const active = !disabled;
  const onDragEnter = (event: DragEvent) => {
    if (!active) return;
    event.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (!active) return;
    // Required for the drop to be allowed at all.
    event.preventDefault();
  };
  const onDragLeave = () => {
    if (!active) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!active) return;
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    deliver(event.dataTransfer.files, true);
  };

  return (
    <div
      className={className === undefined ? 'file-drop file-drop--zone' : `file-drop file-drop--zone ${className}`}
      data-over={over ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <UploadGlyph className="file-drop-glyph" size={20} />
      <span className="file-drop-prompt">{promptText}</span>
      {button}
      {hintNode}
    </div>
  );
}
