/**
 * The Payments surface entry point, mounted by the router at `payments/*`.
 *
 * `/payments/new` is the agent-to-human handover (P21): an agent that will not post (an ambiguous
 * match, a missing capability) hands over a link that opens the allocator already carrying what it
 * established, so a person never retypes money out of a chat message. It is a real route rather than
 * a state, which is what makes it linkable.
 */
import { Routes, Route } from 'react-router-dom';

import { Payments } from './Payments';
import { PaymentsNew } from './PaymentsNew';

export default function PaymentsSurface() {
  return (
    <Routes>
      <Route index element={<Payments />} />
      <Route path="new" element={<PaymentsNew />} />
    </Routes>
  );
}
