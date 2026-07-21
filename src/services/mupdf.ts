/**
 * MuPDF is used only for the visible page bitmap. PDFium remains the source
 * of truth for text geometry, links, outlines and annotations.
 */
export async function initMupdf() {
  return (await import('mupdf')).default
}
