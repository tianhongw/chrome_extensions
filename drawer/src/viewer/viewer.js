// Orchestrator: parse the target PDF, lazily render pages near the viewport
// (so 100s-of-pages PDFs stay light), attach a drawing layer to each visible
// page, keep strokes as canonical data, autosave, and drive the toolbar.
import { loadPdfDocument } from "./pdf-loader.js";
import { DrawingLayer } from "./drawing.js";
import { Store, makeDocId } from "./store.js";
import { exportAnnotatedPdf, exportPagePng } from "./export.js";
import { initToolbar } from "./toolbar.js";

const TB_H = 48;
const RENDER_DPR = Math.min(window.devicePixelRatio || 1, 2);
const EXPORT_SCALE = 1.5; // raster quality when burning annotations into the PDF

const toolState = { tool: "pen", color: "#e53935", width: 3 };

let ui = null;
let pdfDoc = null;
// pages[i] = { pageNum, container, pdfPage, vp1, cssW, cssH, baseCanvas, layer,
//              rendered, rendering, renderTask, strokes }
let pages = [];
let scale = 1.0;
let baseVp1 = null; // page-1 viewport@1, used to size not-yet-rendered pages
let savedPagesData = {};
let io = null;
let store = null;
let docName = "annotated";
let currentPage = 1;
const undoStack = [];
const redoStack = [];
let savedMsgTimer = null;

const pagesEl = document.getElementById("pages");
const welcomeEl = document.getElementById("welcome");
const toolbarEl = document.getElementById("toolbar");
const loadingEl = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const dz = document.getElementById("dropzone");

// ---------------------------------------------------------------- controller
const controller = {
  setTool(tool) {
    toolState.tool = tool;
    ui.setActiveTool(tool);
  },
  setColor(color) {
    toolState.color = color;
    if (toolState.tool !== "pen") controller.setTool("pen");
    ui.setColor(color);
  },
  setWidth(n) {
    toolState.width = n;
    ui.setWidth(n);
  },
  undo,
  redo,
  clearPage,
  exportPdf,
  exportPng,
  zoomIn: () => setScale(scale * 1.15),
  zoomOut: () => setScale(scale / 1.15),
  fitWidth: () => baseVp1 && setScale(computeFitScale(baseVp1)),
  prevPage: () => gotoPage(currentPage - 1),
  nextPage: () => gotoPage(currentPage + 1),
  gotoPage,
};

// ---------------------------------------------------------------- bootstrap
function main() {
  ui = initToolbar(controller);
  ui.setActiveTool(toolState.tool);
  ui.setColor(toolState.color);
  ui.setWidth(toolState.width);
  ui.setZoom(scale);
  ui.setUndoRedo(false, false);
  setupDropOpen();

  const fileUrl = getFileParam();
  if (fileUrl) openFromUrl(fileUrl);
}

function getFileParam() {
  const i = location.href.indexOf("?file=");
  if (i < 0) return null;
  const raw = location.href.slice(i + "?file=".length);
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

// ---------------------------------------------------------------- open paths
async function openFromUrl(url) {
  docName = guessName(url);
  store = new Store(makeDocId(url));
  showLoading();
  try {
    let doc;
    if (/^file:/i.test(url)) {
      const buf = await xhrArrayBuffer(url);
      doc = await loadPdfDocument({ data: new Uint8Array(buf) });
    } else {
      doc = await loadPdfDocument({ url });
    }
    await buildDocument(doc);
  } catch (err) {
    openFailed(url, err);
  }
}

async function openFromFile(file) {
  docName = file.name;
  store = new Store(makeDocId(file.name + ":" + file.size));
  showLoading();
  try {
    const buf = await file.arrayBuffer();
    const doc = await loadPdfDocument({ data: new Uint8Array(buf) });
    await buildDocument(doc);
  } catch (err) {
    openFailed(file.name, err);
  }
}

function xhrArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) resolve(xhr.response);
      else reject(new Error("HTTP " + xhr.status));
    };
    xhr.onerror = () => reject(new Error("无法读取文件（可能未开启文件访问权限）"));
    xhr.send();
  });
}

function guessName(url) {
  try {
    const clean = url.split("#")[0].split("?")[0];
    return decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1)) || "annotated";
  } catch (_) {
    return "annotated";
  }
}

// ---------------------------------------------------------------- build
async function buildDocument(doc) {
  pdfDoc = doc;
  removeErrorNote();
  welcomeEl.hidden = true;
  toolbarEl.hidden = false;
  ui.setPageCount(doc.numPages);

  const saved = await store.load();
  savedPagesData = (saved && saved.pages) || {};

  if (io) io.disconnect();
  pagesEl.innerHTML = "";
  pages = [];
  undoStack.length = 0;
  redoStack.length = 0;
  currentPage = 1;
  ui.setUndoRedo(false, false);

  const first = await doc.getPage(1);
  baseVp1 = first.getViewport({ scale: 1 });
  scale = computeFitScale(baseVp1);
  ui.setZoom(scale);

  // create all page containers (cheap) sized from an estimate so the scroll
  // height is roughly right; real size is set when each page renders.
  for (let n = 1; n <= doc.numPages; n++) {
    const container = document.createElement("div");
    container.className = "page";
    container.dataset.idx = String(n - 1);
    sizeContainer(container, baseVp1);
    pagesEl.appendChild(container);
    pages.push({
      pageNum: n,
      container,
      pdfPage: n === 1 ? first : null,
      vp1: n === 1 ? baseVp1 : null,
      cssW: 0,
      cssH: 0,
      baseCanvas: null,
      layer: null,
      rendered: false,
      rendering: false,
      renderTask: null,
      strokes: savedPagesData[n - 1] || [],
    });
  }

  hideLoading();
  setupLazyRender();
  setupScrollTracking();
  ui.setSaveStatus(saved ? "已恢复笔迹" : "");
}

function sizeContainer(container, vp1) {
  container.style.width = Math.floor(vp1.width * scale) + "px";
  container.style.height = Math.floor(vp1.height * scale) + "px";
}

// ---------------------------------------------------------------- lazy render
function setupLazyRender() {
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = pages[Number(e.target.dataset.idx)];
        if (!p) continue;
        if (e.isIntersecting) ensurePage(p);
        else if (p.rendered) teardownPage(p);
      }
    },
    { root: null, rootMargin: "1200px 0px", threshold: 0 }
  );
  pages.forEach((p) => io.observe(p.container));
}

async function ensurePage(p) {
  if (p.rendered || p.rendering) return;
  p.rendering = true;
  try {
    if (!p.pdfPage) p.pdfPage = await pdfDoc.getPage(p.pageNum);
    if (!p.vp1) p.vp1 = p.pdfPage.getViewport({ scale: 1 });
    if (!p.baseCanvas) {
      p.baseCanvas = document.createElement("canvas");
      p.baseCanvas.className = "base-canvas";
      p.container.appendChild(p.baseCanvas);
    }
    if (!p.layer) {
      p.layer = new DrawingLayer({
        container: p.container,
        pageIndex: p.pageNum - 1,
        toolState,
        onAction,
      });
      p.layer.setStrokes(p.strokes);
    }
    await renderPageBase(p);
    p.rendered = true;
  } catch (err) {
    console.warn("[pdf-drawer] render page failed:", p.pageNum, err);
  } finally {
    p.rendering = false;
  }
}

function teardownPage(p) {
  if (p.renderTask) {
    try {
      p.renderTask.cancel();
    } catch (_) {}
    p.renderTask = null;
  }
  if (p.layer) {
    p.strokes = p.layer.getStrokes(); // preserve handwriting as data
    p.layer.destroy();
    p.layer = null;
  }
  if (p.baseCanvas) {
    p.baseCanvas.remove();
    p.baseCanvas = null;
  }
  p.rendered = false;
  sizeContainer(p.container, p.vp1 || baseVp1); // keep scroll height stable
}

async function renderPageBase(p) {
  if (p.renderTask) {
    try {
      p.renderTask.cancel();
    } catch (_) {}
    p.renderTask = null;
  }
  const viewport = p.pdfPage.getViewport({ scale });
  const cssW = Math.floor(viewport.width);
  const cssH = Math.floor(viewport.height);
  p.cssW = cssW;
  p.cssH = cssH;
  p.container.style.width = cssW + "px";
  p.container.style.height = cssH + "px";

  const canvas = p.baseCanvas;
  canvas.width = Math.floor(viewport.width * RENDER_DPR);
  canvas.height = Math.floor(viewport.height * RENDER_DPR);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  const transform = RENDER_DPR !== 1 ? [RENDER_DPR, 0, 0, RENDER_DPR, 0, 0] : null;

  p.renderTask = p.pdfPage.render({ canvasContext: ctx, viewport, transform });
  try {
    await p.renderTask.promise;
  } catch (e) {
    if (e && e.name !== "RenderingCancelledException") console.warn(e);
  }
  p.renderTask = null;
  if (p.layer) p.layer.resize(cssW, cssH, RENDER_DPR);
}

function computeFitScale(vp1) {
  const avail = (pagesEl.clientWidth || window.innerWidth) - 32;
  return Math.max(0.2, Math.min(avail / vp1.width, 3));
}

async function setScale(s) {
  if (!pages.length) return;
  scale = Math.max(0.2, Math.min(s, 4));
  ui.setZoom(scale);
  const keep = currentPage;
  for (const p of pages) {
    if (p.rendered) await renderPageBase(p);
    else sizeContainer(p.container, p.vp1 || baseVp1);
  }
  scrollToPage(keep, "auto");
}

// ---------------------------------------------------------------- pages nav
function gotoPage(n) {
  n = Math.max(1, Math.min(n, pages.length));
  scrollToPage(n, "smooth");
}

function scrollToPage(n, behavior = "smooth") {
  const p = pages[n - 1];
  if (!p) return;
  const top = p.container.getBoundingClientRect().top + window.scrollY - (TB_H + 12);
  window.scrollTo({ top, behavior });
}

function setupScrollTracking() {
  const onScroll = throttle(() => {
    const mid = window.scrollY + window.innerHeight / 2;
    let best = 1;
    let bestDist = Infinity;
    pages.forEach((p, i) => {
      const rect = p.container.getBoundingClientRect();
      const center = rect.top + window.scrollY + rect.height / 2;
      const d = Math.abs(center - mid);
      if (d < bestDist) {
        bestDist = d;
        best = i + 1;
      }
    });
    if (best !== currentPage) {
      currentPage = best;
      ui.setPage(currentPage);
    }
  }, 150);
  window.addEventListener("scroll", onScroll, { passive: true });
}

// ---------------------------------------------------------------- history
// Strokes are canonical in p.strokes; the layer (when present) is a live view.
function syncStrokes(p, next) {
  p.strokes = next;
  if (p.layer) p.layer.setStrokes(next);
}

function currentStrokes(p) {
  return p.layer ? p.layer.getStrokes() : p.strokes;
}

function onAction(action) {
  const p = pages[action.pageIndex];
  p.strokes = p.layer.getStrokes(); // layer already applied the change
  undoStack.push(action);
  redoStack.length = 0;
  afterMutation();
}

function applyDelta(p, action, adding) {
  const cur = currentStrokes(p);
  if (adding) {
    const toAdd = action.type === "add" ? [action.stroke] : action.strokes;
    syncStrokes(p, cur.concat(toAdd));
  } else {
    const ids = new Set((action.type === "add" ? [action.stroke] : action.strokes).map((s) => s.id));
    syncStrokes(p, cur.filter((s) => !ids.has(s.id)));
  }
}

function undo() {
  const a = undoStack.pop();
  if (!a) return;
  const p = pages[a.pageIndex];
  applyDelta(p, a, a.type !== "add"); // revert: add→remove, remove→add
  redoStack.push(a);
  afterMutation();
  scrollToPage(a.pageIndex + 1, "smooth");
}

function redo() {
  const a = redoStack.pop();
  if (!a) return;
  const p = pages[a.pageIndex];
  applyDelta(p, a, a.type === "add");
  undoStack.push(a);
  afterMutation();
  scrollToPage(a.pageIndex + 1, "smooth");
}

function clearPage() {
  const p = pages[currentPage - 1];
  if (!p) return;
  const cur = currentStrokes(p);
  if (!cur.length) return;
  const action = { type: "remove", pageIndex: p.pageNum - 1, strokes: cur.slice() };
  syncStrokes(p, []);
  undoStack.push(action);
  redoStack.length = 0;
  afterMutation();
}

function afterMutation() {
  ui.setUndoRedo(undoStack.length > 0, redoStack.length > 0);
  persist();
}

function persist() {
  if (!store) return;
  const data = { pages: {}, meta: { name: docName, numPages: pages.length } };
  pages.forEach((p, i) => {
    const s = currentStrokes(p);
    if (s && s.length) data.pages[i] = s;
  });
  ui.setSaveStatus("保存中…");
  store.save(data);
  clearTimeout(savedMsgTimer);
  savedMsgTimer = setTimeout(() => ui.setSaveStatus("已自动保存"), 1000);
}

// ---------------------------------------------------------------- export
async function exportPdf() {
  if (!pages.length) return;
  ui.setSaveStatus("导出中…");
  try {
    const items = [];
    for (const p of pages) {
      const pdfPage = p.pdfPage || (await pdfDoc.getPage(p.pageNum));
      const vp1 = p.vp1 || pdfPage.getViewport({ scale: 1 });
      const vp = pdfPage.getViewport({ scale: EXPORT_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const task = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      await task.promise;
      const strokes = currentStrokes(p);
      // cssW = on-screen CSS width so widthScale = EXPORT_SCALE/scale (matches preview)
      items.push({
        baseCanvas: canvas,
        cssW: vp1.width * scale,
        vp1,
        layer: { getStrokes: () => strokes },
      });
    }
    exportAnnotatedPdf(items, docName);
    ui.setSaveStatus("已导出 PDF");
  } catch (e) {
    console.error(e);
    ui.setSaveStatus("导出失败");
  }
}

function exportPng() {
  const p = pages[currentPage - 1];
  if (!p || !p.baseCanvas) return;
  exportPagePng(p, docName, currentPage);
}

// ---------------------------------------------------------------- drop-to-open
function setupDropOpen() {
  const fileInput = document.getElementById("file-input");
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) openFromFile(fileInput.files[0]);
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  });
  window.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /pdf/i.test((f.type || "") + " " + f.name)) openFromFile(f);
  });
}

// ---------------------------------------------------------------- ui helpers
function showLoading(text = "正在加载 PDF…") {
  loadingText.textContent = text;
  loadingEl.hidden = false;
  welcomeEl.hidden = true;
}
function hideLoading() {
  loadingEl.hidden = true;
}

function openFailed(target, err) {
  console.error("[pdf-drawer] open failed:", err);
  hideLoading();
  welcomeEl.hidden = false;
  toolbarEl.hidden = true;
  let note = document.getElementById("error-note");
  if (!note) {
    note = document.createElement("p");
    note.id = "error-note";
    note.className = "hint";
    note.style.color = "#ff8a80";
    dz.insertBefore(note, dz.firstChild);
  }
  note.textContent = String(target).startsWith("file:")
    ? "无法读取本地文件：请在 chrome://extensions 本扩展详情里开启「允许访问文件网址」，或用下方按钮手动选择该 PDF。"
    : "加载 PDF 失败：" + ((err && err.message) || err);
}

function removeErrorNote() {
  const note = document.getElementById("error-note");
  if (note) note.remove();
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const run = () => {
      last = Date.now();
      fn(...args);
    };
    if (now - last >= ms) run();
    else {
      clearTimeout(timer);
      timer = setTimeout(run, ms - (now - last));
    }
  };
}

main();
