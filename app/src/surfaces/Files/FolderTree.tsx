/**
 * The filing tree, in the left rail: create, rename inline, delete when empty.
 *
 * THE TREE IS FLAT AND THE INDENT IS THE HIERARCHY. `folders_list` answers in path order, which already
 * IS tree order for a rail that indents by depth, so nothing here assembles a tree from parent pointers.
 * That is not a shortcut: an assembled tree has to decide what to do with a row whose parent is missing,
 * and the flat list simply cannot represent that question.
 *
 * DELETE IS DISABLED WITH A REASON, NEVER CLICK-THEN-REJECT. The engine's own rule (`deletable`) arrives
 * on the row, so the control is disabled from the same fact the refusal would name, and the tooltip says
 * which of the two reasons applies. A control that looks available and then refuses teaches an operator
 * that the screen does not know what it is doing.
 *
 * RENAME IS AN INLINE EDIT of the label and not a dialog: it is a one-field change to something already
 * on screen, and a modal for that is a modal for nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n';
import { OverflowMenu } from '../../components/OverflowMenu';
import { FolderGlyph } from './glyphs';
import type { FileFolder } from './model';

export interface FolderTreeProps {
  folders: readonly FileFolder[];
  /** The folder whose files the list is showing, or null for "every file in the workspace". */
  selectedId: string | null;
  onSelect: (folderId: string | null) => void;
  onCreate: (name: string, parentId: string | null) => Promise<boolean>;
  onRename: (folderId: string, name: string) => Promise<boolean>;
  onDelete: (folderId: string) => void;
  /** False when the actor lacks `manage_master_data`: the tree still renders, the affordances do not. */
  canWrite: boolean;
}

export function FolderTree({
  folders,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  canWrite,
}: FolderTreeProps) {
  const t = useT();
  /** Which row is being renamed, or `'new'` while a child of the selection is being named. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);

  const startCreate = useCallback(() => {
    setDraft('');
    setEditing('new');
  }, []);

  const commit = useCallback(async () => {
    const name = draft.trim();
    if (name.length === 0) {
      setEditing(null);
      return;
    }
    const done = editing === 'new' ? await onCreate(name, selectedId) : await onRename(editing as string, name);
    // A refusal keeps the field open with the value still in it. Closing the editor on a rejection
    // would throw away what the operator typed and leave the reason on screen with nothing to fix.
    if (done) setEditing(null);
  }, [draft, editing, onCreate, onRename, selectedId]);

  // The create control's label depends on whether a folder is selected, so the FIELD carries the same
  // words as the button that opened it. Labelling the input "Neuer Ordner" under a button reading
  // "Neuer Unterordner" is a screen reader being told something the screen does not say.
  const createLabel = selectedId === null ? t('files.folder.action.new') : t('files.folder.action.newChild');

  // ONE editor, used for both the create row and an inline rename, because it is one job. Two copies
  // would be two places for the Escape handler to be forgotten in, which is exactly how `BankDrawer`
  // came to exist as its own file.
  const editorInput = (
    <input
      ref={inputRef}
      className="field files-tree-input"
      type="text"
      value={draft}
      aria-label={editing === 'new' ? createLabel : t('files.folder.action.rename')}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void commit();
        if (event.key === 'Escape') setEditing(null);
      }}
      onBlur={() => void commit()}
    />
  );

  return (
    <nav className="files-tree panel" aria-label={t('files.folder.tree')}>
      <ul className="files-tree-list">
        <li className="files-tree-row">
          <button
            type="button"
            className={selectedId === null ? 'files-tree-name files-tree-name--active' : 'files-tree-name'}
            aria-current={selectedId === null ? 'true' : undefined}
            onClick={() => onSelect(null)}
          >
            <FolderGlyph />
            <span>{t('files.folder.all')}</span>
          </button>
        </li>
        {folders.map((folder) =>
          editing === folder.id ? (
            <li key={folder.id} className="files-tree-row files-tree-row--editing">
              {editorInput}
            </li>
          ) : (
            <li key={folder.id} className="files-tree-row" style={{ paddingInlineStart: `${folder.depth * 16}px` }}>
              <button
                type="button"
                className={selectedId === folder.id ? 'files-tree-name files-tree-name--active' : 'files-tree-name'}
                aria-current={selectedId === folder.id ? 'true' : undefined}
                onClick={() => onSelect(folder.id)}
              >
                <FolderGlyph />
                <span>{folder.name}</span>
                {/* Tabular numerals, and only when there is something to count: a "0" on every empty
                    folder is noise on the rail that is supposed to be scanned. */}
                {folder.fileCount > 0 && <span className="files-tree-count">{folder.fileCount}</span>}
              </button>
              {canWrite && (
                // K-21: the two verbs, written out, behind one quiet overflow instead of "Umb." and a
                // red "Lö." on every folder. A delete the engine would refuse stays in the menu,
                // disabled, and its label says why in the engine's own two reasons, told apart:
                // "empty it first" is useless advice for a folder whose only content is a subfolder.
                <OverflowMenu
                  quiet
                  label={t('files.folder.actions', { name: folder.name })}
                  items={[
                    {
                      key: 'rename',
                      label: t('files.folder.action.rename'),
                      onSelect: () => {
                        setDraft(folder.name);
                        setEditing(folder.id);
                      },
                    },
                    {
                      key: 'delete',
                      label: folder.deletable
                        ? t('files.folder.action.delete')
                        : folder.childCount > 0
                          ? t('files.folder.action.deleteBlockedChildren')
                          : t('files.folder.action.deleteBlockedFiles'),
                      danger: true,
                      disabled: !folder.deletable,
                      onSelect: () => onDelete(folder.id),
                    },
                  ]}
                />
              )}
            </li>
          ),
        )}
        {editing === 'new' && <li className="files-tree-row files-tree-row--editing">{editorInput}</li>}
      </ul>
      {canWrite && (
        <button type="button" className="btn btn--ghost btn--sm files-tree-new" onClick={startCreate}>
          {createLabel}
        </button>
      )}
    </nav>
  );
}
