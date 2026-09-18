// Wire the static toolbar DOM to a controller (implemented in viewer.js) and
// register keyboard shortcuts. Returns a `ui` object viewer.js uses to reflect
// state back into the toolbar (active tool, page number, zoom, save status…).
const $ = (id) => document.getElementById(id);

export function initToolbar(controller) {
  const penBtn = $("tool-pen");
  const eraserBtn = $("tool-eraser");
  const swatches = Array.from(document.querySelectorAll(".swatch"));
  const customColor = $("color-custom");
  const widthInput = $("width");
  const widthVal = $("width-val");
  const undoBtn = $("undo");
  const redoBtn = $("redo");
  const clearBtn = $("clear");
  const prevBtn = $("prev");
  const nextBtn = $("next");
  const pageInput = $("page-input");
  const pageCount = $("page-count");
  const zoomIn = $("zoom-in");
  const zoomOut = $("zoom-out");
  const zoomLevel = $("zoom-level");
  const fitWidth = $("fit-width");
  const exportPdf = $("export-pdf");
  const exportPng = $("export-png");
  const saveStatus = $("save-status");

  // ---- tools ----
  penBtn.addEventListener("click", () => controller.setTool("pen"));
  eraserBtn.addEventListener("click", () => controller.setTool("eraser"));

  // ---- color ----
  swatches.forEach((sw) =>
    sw.addEventListener("click", () => controller.setColor(sw.dataset.color))
  );
  customColor.addEventListener("input", () => controller.setColor(customColor.value));

  // ---- width ----
  widthInput.addEventListener("input", () =>
    controller.setWidth(Number(widthInput.value))
  );

  // ---- actions ----
  undoBtn.addEventListener("click", () => controller.undo());
  redoBtn.addEventListener("click", () => controller.redo());
  clearBtn.addEventListener("click", () => controller.clearPage());
  exportPdf.addEventListener("click", () => controller.exportPdf());
  exportPng.addEventListener("click", () => controller.exportPng());

  // ---- pages ----
  prevBtn.addEventListener("click", () => controller.prevPage());
  nextBtn.addEventListener("click", () => controller.nextPage());
  pageInput.addEventListener("change", () =>
    controller.gotoPage(Number(pageInput.value))
  );

  // ---- zoom ----
  zoomIn.addEventListener("click", () => controller.zoomIn());
  zoomOut.addEventListener("click", () => controller.zoomOut());
  fitWidth.addEventListener("click", () => controller.fitWidth());

  // ---- keyboard shortcuts ----
  document.addEventListener("keydown", (e) => {
    const typing =
      e.target.tagName === "INPUT" || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? controller.redo() : controller.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      controller.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      controller.exportPdf();
      return;
    }
    if (typing || mod) return;
    if (e.key === "p" || e.key === "P") controller.setTool("pen");
    else if (e.key === "e" || e.key === "E") controller.setTool("eraser");
    else if (e.key === "[") controller.prevPage();
    else if (e.key === "]") controller.nextPage();
  });

  // ---- ui reflection API ----
  return {
    setActiveTool(tool) {
      penBtn.classList.toggle("active", tool === "pen");
      eraserBtn.classList.toggle("active", tool === "eraser");
      document.body.classList.toggle("eraser-mode", tool === "eraser");
    },
    setColor(color) {
      customColor.value = color;
      swatches.forEach((sw) =>
        sw.classList.toggle("active", sw.dataset.color === color)
      );
    },
    setWidth(n) {
      widthInput.value = String(n);
      widthVal.textContent = String(n);
    },
    setPage(n) {
      if (document.activeElement !== pageInput) pageInput.value = String(n);
    },
    setPageCount(n) {
      pageCount.textContent = String(n);
      pageInput.max = String(n);
    },
    setZoom(scale) {
      zoomLevel.textContent = Math.round(scale * 100) + "%";
    },
    setSaveStatus(text) {
      saveStatus.textContent = text;
    },
    setUndoRedo(canUndo, canRedo) {
      undoBtn.disabled = !canUndo;
      redoBtn.disabled = !canRedo;
    },
  };
}
