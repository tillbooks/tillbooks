/**
 * The SHARED saved-view picker, mounted in any entity list's toolbar.
 *
 * The other half of the framework. A list surface renders this, hands it the views `list_saved_views`
 * returned, and passes the chosen id straight into its own list call as `savedViewId`: the engine
 * merges the stored filters underneath the caller's own. The component performs no filtering itself,
 * which is the point, because the moment it did, the browser and the engine would be two
 * implementations of one filter and a list would mean different things on two surfaces.
 *
 * PERSONAL AND SHARED ARE SEPARATED IN THE LIST rather than merged and sorted, because they answer
 * different questions ("the filter I always use" against "the filter this office agreed on") and
 * because a Treuhänder needs to see at a glance which of the two they are about to change.
 */
export interface SavedViewDto {
  viewId: string;
  entityKind: string;
  name: string;
  shared: boolean;
  ownerActor: string | null;
  filters: Record<string, unknown>;
  sort: unknown[];
  columns: string[];
  layout: string;
  isDefault: boolean;
}

export interface SavedViewPickerProps {
  views: readonly SavedViewDto[];
  /** The chosen view, or null for the built-in default view. */
  selected: string | null;
  label: string;
  defaultOptionLabel: string;
  personalGroupLabel: string;
  sharedGroupLabel: string;
  disabled?: boolean;
  onSelect: (viewId: string | null) => void;
}

export function SavedViewPicker({
  views,
  selected,
  label,
  defaultOptionLabel,
  personalGroupLabel,
  sharedGroupLabel,
  disabled = false,
  onSelect,
}: SavedViewPickerProps) {
  const personal = views.filter((v) => !v.shared);
  const shared = views.filter((v) => v.shared);

  return (
    <label className="saved-view-picker">
      <span className="saved-view-picker__label">{label}</span>
      <select
        value={selected ?? ''}
        disabled={disabled}
        onChange={(e) => onSelect(e.currentTarget.value === '' ? null : e.currentTarget.value)}
      >
        {/* Never an empty dropdown: the built-in default is always an option, so a list always has a
            view selected even before anyone has saved one. */}
        <option value="">{defaultOptionLabel}</option>
        {personal.length > 0 ? (
          <optgroup label={personalGroupLabel}>
            {personal.map((view) => (
              <option key={view.viewId} value={view.viewId}>
                {view.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {shared.length > 0 ? (
          <optgroup label={sharedGroupLabel}>
            {shared.map((view) => (
              <option key={view.viewId} value={view.viewId}>
                {view.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}
