/** Security review (12.11.2026): a withheld current IBAN reads "nicht sichtbar", never "keine". */
import { describe, it, expect } from 'vitest';

import { oldIbanText } from './vorschlagView';

const t = (key: string) => key;

describe('oldIbanText', () => {
  it('says the IBAN when the seat may read it', () => {
    expect(oldIbanText(t, { contactName: 'Rahmenbau Beispiel AG', oldIban: 'CH9300762011623852957', newIban: 'CH4431999123000889012', withheld: false })).toBe('CH9300762011623852957');
  });
  it('says none only when none is set', () => {
    expect(oldIbanText(t, { contactName: 'Neu', oldIban: null, newIban: 'CH4431999123000889012', withheld: false })).toBe('agent.vq.ibanNone');
  });
  it('says withheld, never none, for a seat without the master-data read', () => {
    expect(oldIbanText(t, { contactName: null, oldIban: null, newIban: 'CH4431999123000889012', withheld: true })).toBe('agent.vq.ibanWithheld');
  });
});
