/**
 * The Dateien surface's read model: parse what the engine SENDS, and nothing else.
 *
 * Every field below exists in a `files_search`, `files_list_linked` or `folders_list` payload. Nothing
 * here is derived in the browser that the engine already answers, and that is a rule with a history:
 * three Studio gates once read `canPost`, `canManage` and `canUnlock` off list payloads that have never
 * carried them, so all three evaluated `undefined !== false` and stood open in every shipped build. The
 * two facts this surface is most tempted to compute for itself are exactly the two the engine sends:
 * `retentionLocked` (a date comparison against the engine's clock, not the browser's) and `deletable`
 * on a folder (the same rule the engine refuses with). Reading them is what keeps the screen and the
 * guard from disagreeing.
 *
 * A parse returns `null` on a shape this surface cannot read, which the caller renders as a failed read
 * rather than as an empty list. An empty list is a fact about the workspace; an unreadable payload is a
 * fact about the build, and showing "Noch keine Dateien" for the second is how a broken read looks
 * exactly like a new workspace.
 */

export interface StoredFile {
  id: string;
  folderId: string | null;
  title: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  tags: string[];
  entityKind: string | null;
  entityId: string | null;
  retentionUntil: string | null;
  retentionSource: string | null;
  retentionLocked: boolean;
  version: number;
  supersedesId: string | null;
  pendingDelete: boolean;
  createdAt: string;
  updatedAt: string;
  /** Present only when the read asked for `includeVersions`, oldest first. */
  versions?: StoredFile[];
}

export interface FileFolder {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  depth: number;
  fileCount: number;
  childCount: number;
  deletable: boolean;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nullableStr = (v: unknown): string | null | undefined =>
  v === null || typeof v === 'string' ? (v as string | null) : undefined;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function parseFile(raw: unknown): StoredFile | null {
  const r = obj(raw);
  if (r === null) return null;
  const id = str(r.id);
  const title = str(r.title);
  const filename = str(r.filename);
  const mime = str(r.mime);
  const bytes = num(r.bytes);
  const sha256 = str(r.sha256);
  const version = num(r.version);
  const createdAt = str(r.createdAt);
  const updatedAt = str(r.updatedAt);
  const retentionLocked = bool(r.retentionLocked);
  const pendingDelete = bool(r.pendingDelete);
  const folderId = nullableStr(r.folderId);
  const entityKind = nullableStr(r.entityKind);
  const entityId = nullableStr(r.entityId);
  const retentionUntil = nullableStr(r.retentionUntil);
  const retentionSource = nullableStr(r.retentionSource);
  const supersedesId = nullableStr(r.supersedesId);
  if (
    id === null ||
    title === null ||
    filename === null ||
    mime === null ||
    bytes === null ||
    sha256 === null ||
    version === null ||
    createdAt === null ||
    updatedAt === null ||
    retentionLocked === null ||
    pendingDelete === null ||
    folderId === undefined ||
    entityKind === undefined ||
    entityId === undefined ||
    retentionUntil === undefined ||
    retentionSource === undefined ||
    supersedesId === undefined
  ) {
    return null;
  }
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
  const file: StoredFile = {
    id,
    folderId,
    title,
    filename,
    mime,
    bytes,
    sha256,
    tags,
    entityKind,
    entityId,
    retentionUntil,
    retentionSource,
    retentionLocked,
    version,
    supersedesId,
    pendingDelete,
    createdAt,
    updatedAt,
  };
  if (Array.isArray(r.versions)) {
    const versions = r.versions.map(parseFile);
    // A history with one unreadable member is an unreadable history: showing the rest would present a
    // gap in a version chain as if the chain had a gap, which is the one thing OR 958f says it cannot.
    if (versions.some((v) => v === null)) return null;
    file.versions = versions as StoredFile[];
  }
  return file;
}

export function parseFiles(body: unknown): StoredFile[] | null {
  const r = obj(body);
  if (r === null || !Array.isArray(r.files)) return null;
  const parsed = r.files.map(parseFile);
  return parsed.some((f) => f === null) ? null : (parsed as StoredFile[]);
}

/**
 * The D34 truncation facts off a `files_search` answer, or null when the engine did not truncate.
 *
 * READ RATHER THAN IGNORED, which it was until 30.07.2026. `files_search` has always answered
 * `{truncated, total, ceiling}` and this surface used none of the three, so a workspace past the ceiling
 * showed a thousand rows with nothing saying so: a list silently missing its tail is worse than a short
 * list, because an operator who cannot find a voucher concludes it was never filed.
 */
export function parseTruncation(body: unknown): { total: number; ceiling: number } | null {
  const r = obj(body);
  if (r === null || bool(r.truncated) !== true) return null;
  const total = num(r.total);
  const ceiling = num(r.ceiling);
  return total === null || ceiling === null ? null : { total, ceiling };
}

export function parseFolders(body: unknown): FileFolder[] | null {
  const r = obj(body);
  if (r === null || !Array.isArray(r.folders)) return null;
  const out: FileFolder[] = [];
  for (const raw of r.folders) {
    const f = obj(raw);
    if (f === null) return null;
    const id = str(f.id);
    const name = str(f.name);
    const path = str(f.path);
    const depth = num(f.depth);
    const fileCount = num(f.fileCount);
    const childCount = num(f.childCount);
    const deletable = bool(f.deletable);
    const parentId = nullableStr(f.parentId);
    if (
      id === null ||
      name === null ||
      path === null ||
      depth === null ||
      fileCount === null ||
      childCount === null ||
      deletable === null ||
      parentId === undefined
    ) {
      return null;
    }
    out.push({ id, name, parentId, path, depth, fileCount, childCount, deletable });
  }
  return out;
}

/**
 * A byte count as a person reads it.
 *
 * ONE helper, here, rather than an expression in each component: the spec's P11 note asks for exactly
 * that, and a size formatted two ways on one screen reads as two different facts. Binary units, because
 * the cap the engine enforces is a binary one (25 MiB) and a refusal that says "over 25 MiB" beside a
 * list that says "26.2 MB" is a screen arguing with itself. `Intl` is not used: it has no byte unit
 * that produces the Swiss decimal comma consistently across the two locales, and this is a technical
 * quantity rather than a localised one.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10, none above: `1.4 MiB` and `240 KiB` are both what a person wanted to know,
  // and `1.437 MiB` is not.
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/** The i18n suffix for a mime type's glyph and label. Everything unrecognised is a generic file. */
export function mimeKind(mime: string): 'pdf' | 'image' | 'sheet' | 'text' | 'other' {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('spreadsheet') || mime === 'text/csv' || mime.includes('excel')) return 'sheet';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * Turn a browser `File` into the shape `files_upload` takes.
 *
 * `FileReader.readAsDataURL` AND NOT `arrayBuffer()` + `btoa`, for two independent reasons that point
 * the same way. The browser does the base64 itself, so there is no hand-rolled byte loop to get wrong:
 * the obvious `btoa(String.fromCharCode(...bytes))` blows the argument limit on a multi-megabyte file
 * and throws, which would fail a large-but-legal PDF in the browser with a stack trace instead of
 * reaching the engine's own `file_too_large` refusal. And `File.arrayBuffer()` is not implemented in
 * every environment this code is TESTED in, so the older API is the one that works everywhere the
 * newer one does and in one place more.
 *
 * The data URL is `data:<mime>;base64,<payload>`, so everything after the first comma is exactly what
 * the verb wants. A zero-byte file produces an empty payload, which the ENGINE refuses with
 * `file_unreadable`: the refusal belongs there and not here, so that an agent calling the verb directly
 * gets the same answer a person does.
 */
export async function readFileAsUpload(
  file: File,
): Promise<{ filename: string; mime: string; contentBase64: string; bytes: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('file_unreadable'));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(',');
  return {
    filename: file.name,
    // A browser leaves `type` empty for an extension it does not know. Sending the empty string would
    // store a file whose mime is '' and whose glyph is therefore undecidable; naming the same default
    // the engine uses keeps one answer for "unknown".
    mime: file.type === '' ? 'application/octet-stream' : file.type,
    contentBase64: comma === -1 ? '' : dataUrl.slice(comma + 1),
    bytes: file.size,
  };
}

/** Trigger a real download of what `files_get_content` handed back, verified bytes and all. */
export function downloadContent(payload: { contentBase64: string; mime: string; filename: string }): void {
  const binary = atob(payload.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = payload.filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: a synchronous revoke races the click in Safari
  // and the download silently produces a zero-byte file.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
