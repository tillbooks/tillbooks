/**
 * The editor's (i) (D152 rule 4, words on demand): the shared `Tooltip` over a ghost icon button
 * carrying `InfoGlyph`, the pattern `/dispatch` and `/operations` use. The explanation stays in the
 * DOM, tied to the trigger by `aria-describedby`, so a screen reader hears it on focus and a
 * sighted reader sees it on hover or focus. It holds plain text only: a way out (a link) stays on
 * the surface, because a tooltip must not carry interactive content.
 */
import { IconButton } from '../../components/IconButton';

export interface EditorInfoProps {
  /** The trigger's accessible name, e.g. "Mehr zur Währung". */
  label: string;
  /** The explanation the card holds (plain text). */
  children: string;
  /** A state marker the browser flows wait on (CurrencyPicker's `data-fx`). */
  dataFx?: string;
}

export function EditorInfo({ label, children, dataFx }: EditorInfoProps) {
  return (
    <span className="documents-info" data-fx={dataFx}>
      <IconButton icon="info" small name={label} context={children} placement="bottom" />
    </span>
  );
}
