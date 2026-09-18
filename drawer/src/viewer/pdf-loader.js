// PDF.js setup. The worker, CMaps (needed for CJK / 中文 text) and standard
// fonts are all bundled in the extension and referenced via chrome.runtime.getURL
// so everything stays same-origin under the MV3 CSP.
import * as pdfjsLib from "../../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "vendor/pdf.worker.min.mjs"
);

const CMAP_URL = chrome.runtime.getURL("vendor/cmaps/");
const STANDARD_FONT_URL = chrome.runtime.getURL("vendor/standard_fonts/");

/**
 * Load a PDF document. Pass { url } for a remote/file URL, or { data } for an
 * ArrayBuffer/Uint8Array (manual drag-and-drop open).
 * @returns {Promise<import('../../vendor/pdf.min.mjs').PDFDocumentProxy>}
 */
export function loadPdfDocument(src) {
  const task = pdfjsLib.getDocument({
    ...src,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
  });
  return task.promise;
}

export { pdfjsLib };
