/**
 * `/payments/new`, the Werkbank matcher as a real route (D113), and the P21 agent-to-human handover.
 *
 * The matcher is a place you GO, not an overlay toggled by a query flag, so it survives a reload
 * mid-allocation and is shareable as a URL. All four entry points navigate here rather than opening a
 * drawer of their own:
 *
 *   - the payments list "Zahlung erfassen" button  ->  /payments/new
 *   - a parked Guthaben's "Zuweisen"                ->  /payments/new?allocate=<paymentId>
 *   - a vendor bill's "Zahlung erfassen"            ->  /payments/new?direction=outgoing&amount=...
 *   - an agent handing over an established payment   ->  /payments/new?amount=...&reference=...
 *
 * The money side and the matcher CONTEXT arrive as URL parameters, so a reload reopens the same
 * matcher: `allocate` selects allocation mode against an existing payment's credit (P46), and
 * `amount`/`date`/`reference`/`direction`/`counterparty` seed a new one. Nothing is posted on arrival:
 * a URL is not a statement that money should move.
 *
 * The list renders behind the workbench, so closing it leaves the person somewhere real rather than on
 * a blank route.
 */
import { useNavigate, useSearchParams } from 'react-router-dom';

import { Payments } from './Payments';
import { PaymentAllocator } from './PaymentAllocator';

export function PaymentsNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const close = () => navigate('/payments');
  // The Commit moment (D122 D-I): the list behind the workbench lands the row just recorded. The id
  // rides router state, never the URL, so a shared link or a reload does not re-land it.
  const posted = (paymentId?: string) =>
    navigate('/payments', paymentId === undefined ? undefined : { state: { justRecorded: paymentId } });

  // `allocate=<paymentId>` spends an existing Guthaben; its absence records a new payment. The context
  // is entirely in the URL, so a reload lands on the identical matcher.
  const allocateFor = params.get('allocate');

  return (
    <>
      <Payments />
      {allocateFor !== null ? (
        <PaymentAllocator mode="allocate" paymentId={allocateFor} onClose={close} onPosted={posted} />
      ) : (
        <PaymentAllocator
          mode="record"
          prefill={{
            amount: params.get('amount') ?? undefined,
            date: params.get('date') ?? undefined,
            reference: params.get('reference') ?? undefined,
            direction: params.get('direction') ?? undefined,
            counterpartyId: params.get('counterparty') ?? undefined,
          }}
          onClose={close}
          onPosted={posted}
        />
      )}
    </>
  );
}
