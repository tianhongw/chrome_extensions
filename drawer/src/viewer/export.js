// Export the annotated document. Each page is composited (PDF render + strokes)
// at the base canvas's device resolution, then placed into a PDF page sized in
// PDF points (the scale-1 viewport), so output stays crisp regardless of zoom.
import { paintStrokes } from "./drawing.js";

/** Composite one page's base render + strokes onto a fresh opaque canvas. */
function compositePage(page) {
  const w = page.baseCanvas.width;
  const h = page.baseCanvas.height;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  ctx.fillStyle = "#ffffff"; // flatten any transparency for JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(page.baseCanvas, 0, 0);
  // strokes stored normalized; widthScale maps CSS-px widths to device px
  const widthScale = w / page.cssW;
  paintStrokes(ctx, page.layer.getStrokes(), w, h, widthScale);
  return off;
}

function sanitize(name) {
  return (name || "annotated").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_");
}

/** Build and download a PDF with handwriting burned in. */
export function exportAnnotatedPdf(pages, baseName) {
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (const page of pages) {
    const off = compositePage(page);
    const ptW = page.vp1.width;
    const ptH = page.vp1.height;
    const orientation = ptW >= ptH ? "landscape" : "portrait";
    const img = off.toDataURL("image/jpeg", 0.92);
    if (!doc) {
      doc = new jsPDF({ orientation, unit: "pt", format: [ptW, ptH] });
    } else {
      doc.addPage([ptW, ptH], orientation);
    }
    doc.addImage(img, "JPEG", 0, 0, ptW, ptH);
  }
  if (doc) doc.save(`${sanitize(baseName)}-批注.pdf`);
}

/** Download a single page as PNG. */
export function exportPagePng(page, baseName, pageNum) {
  const off = compositePage(page);
  const a = document.createElement("a");
  a.href = off.toDataURL("image/png");
  a.download = `${sanitize(baseName)}-第${pageNum}页.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
