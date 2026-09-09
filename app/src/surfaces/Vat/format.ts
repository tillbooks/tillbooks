/** Render a basis-point rate as a percentage: `810` -> `8.1%`. Never a hardcoded literal. */
export function formatRatePct(rateBp: number): string {
  return `${(rateBp / 100).toFixed(1)}%`;
}

/** The i18n leaf segment for a kind: `reverse_charge` -> `reverseCharge` (matches the message keys). */
export function kindKeySegment(kind: string): string {
  return kind.replace(/_([a-z])/g, (_whole, ch: string) => ch.toUpperCase());
}

/** Which optgroup a kind belongs to (S9 groups so each stays under 7, the Hick fix). */
export function groupOf(kind: string): 'output' | 'input' | 'special' | 'exempt' {
  if (kind === 'output') return 'output';
  if (kind === 'input') return 'input';
  if (kind === 'reverse_charge' || kind === 'import') return 'special';
  return 'exempt';
}
