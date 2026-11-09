/**
 * D180: the Übersicht's saved-view picker. It renders exactly like the shared `SavedViewPicker` (the
 * same `.saved-view-picker` markup over the shared `Select`), with one row the shared one does not
 * need: "Angepasst", a disabled row beside Standardansicht at the top that names the state where the
 * layout matches neither the standard nor the view last applied. So the trigger is never empty and
 * never claims "Standardansicht" for a layout that is not. The shared picker and its other callers are
 * untouched.
 */
import { Select, type SelectGroup, type SelectOption } from '../../components/Select';
import type { SavedViewDto } from '../Customization/SavedViewPicker';

/** The value of the Angepasst row: it matches no view id. */
export const CUSTOMISED = '__customised';

export interface ViewPickerProps {
  views: readonly SavedViewDto[];
  /** The view last applied, or null. */
  selected: string | null;
  /** The layout differs from both the standard and the view last applied. */
  customised: boolean;
  label: string;
  defaultOptionLabel: string;
  customisedLabel: string;
  personalGroupLabel: string;
  sharedGroupLabel: string;
  /** A view chosen, or null for Standardansicht. */
  onSelect: (viewId: string | null) => void;
}

export function ViewPicker({
  views,
  selected,
  customised,
  label,
  defaultOptionLabel,
  customisedLabel,
  personalGroupLabel,
  sharedGroupLabel,
  onSelect,
}: ViewPickerProps) {
  const personal = views.filter((v) => !v.shared);
  const shared = views.filter((v) => v.shared);
  const groups: SelectGroup[] = [];
  if (personal.length > 0) groups.push({ label: personalGroupLabel, options: personal.map((v) => ({ value: v.viewId, label: v.name })) });
  if (shared.length > 0) groups.push({ label: sharedGroupLabel, options: shared.map((v) => ({ value: v.viewId, label: v.name })) });
  const top: SelectOption[] = [{ value: '', label: defaultOptionLabel }];
  if (customised) top.push({ value: CUSTOMISED, label: customisedLabel, disabled: true });
  const value = selected ?? (customised ? CUSTOMISED : '');
  return (
    <div className="saved-view-picker">
      <span className="saved-view-picker__label">{label}</span>
      <Select
        value={value}
        onChange={(v) => {
          if (v !== CUSTOMISED) onSelect(v === '' ? null : v);
        }}
        options={top}
        groups={groups}
        ariaLabel={label}
      />
    </div>
  );
}
