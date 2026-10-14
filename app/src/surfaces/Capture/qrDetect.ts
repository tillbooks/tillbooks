/**
 * A31 §0a item 12: find a Swiss QR Code in an IMAGE capture with the browser's own `BarcodeDetector`.
 *
 * ZERO DEPENDENCY, BY DESIGN. The core admits no raster decoder, and a decoder library in the Studio
 * would be a new runtime dependency (an owner decision). Where the browser ships `BarcodeDetector`
 * (Chromium-based browsers on macOS and Android, at the time of writing) this reads the code for free;
 * where it does not, this returns null and the surface shows nothing extra. PDFs are not rendered to
 * pixels here: that would need a PDF rasteriser, the same owner decision.
 *
 * The text found is only ever a PRE-FILL: the person reads it in, so the fields land as an operator
 * assertion and nothing machine-found is written behind anyone's back.
 */

interface DetectedBarcode {
  rawValue?: unknown;
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmap): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | undefined {
  const ctor = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof ctor === 'function' ? (ctor as BarcodeDetectorCtor) : undefined;
}

/** The first QR code in the image whose text is a Swiss QR Code payload (`SPC` header), or null. */
export async function detectSwissQrText(file: Blob): Promise<string | null> {
  const Ctor = detectorCtor();
  if (Ctor === undefined || typeof createImageBitmap !== 'function') return null;
  if (!file.type.startsWith('image/')) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    const detector = new Ctor({ formats: ['qr_code'] });
    bitmap = await createImageBitmap(file);
    const found = await detector.detect(bitmap);
    for (const code of found) {
      if (typeof code.rawValue === 'string' && /^\uFEFF?SPC(\r\n|\n)/.test(code.rawValue)) return code.rawValue;
    }
    return null;
  } catch {
    // An unsupported format, an image the browser cannot decode, a detector without qr_code: all are
    // "nothing found", never an error the person has to handle.
    return null;
  } finally {
    bitmap?.close();
  }
}
