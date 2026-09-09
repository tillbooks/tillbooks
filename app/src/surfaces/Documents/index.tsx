/**
 * Route entry for the Documents surface (A10, the document lifecycle).
 *
 * Documents owns a small nested route tree under `/documents` (S1 list, S2 new-draft editor, and the
 * S3-or-S2 detail route that follows the document's status). The parent route in the app router mounts
 * this with a splat, so the sub-routes resolve here and the surface stays self-contained.
 */
import { Routes, Route } from 'react-router-dom';

import './Documents.css';
import { Documents } from './Documents';
import { DocumentEditor } from './DocumentEditor';
import { DocumentRoute } from './DocumentDetail';
import { InvoiceEditor } from './InvoiceEditor';

export function DocumentsSurface() {
  return (
    <Routes>
      <Route index element={<Documents />} />
      <Route path="new" element={<DocumentEditor />} />
      {/* A11 §6: there is no /invoices screen (the design CUT it, S1 with ?type=invoice is the same
          surface). This is the invoice-scoped CREATE entry point, where the type is pinned rather
          than read from a url that a stale link could carry. */}
      <Route path="new-invoice" element={<InvoiceEditor />} />
      <Route path=":id" element={<DocumentRoute />} />
    </Routes>
  );
}

export default DocumentsSurface;
export { Documents, InvoiceEditor };
