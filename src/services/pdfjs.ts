/**
 * pdf.js is used only for the visible page bitmap. PDFium remains the source
 * of truth for text geometry, links, outlines and annotations.
 */
export async function initPdfjs() {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  }
  return pdfjs
}

const PDF_ASSETS = `${import.meta.env.BASE_URL}pdfjs/`

/** Decoder, CMap and font assets needed by scanned, CJK and non-embedded-font PDFs. */
export const pdfAssetOptions = {
  wasmUrl: `${PDF_ASSETS}wasm/`,
  iccUrl: `${PDF_ASSETS}iccs/`,
  cMapUrl: `${PDF_ASSETS}cmaps/`,
  standardFontDataUrl: `${PDF_ASSETS}standard_fonts/`,
}
