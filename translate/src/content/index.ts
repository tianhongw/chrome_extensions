import bubbleCss from "./bubble.css?inline";
import type { TranslateEvent, TranslateRequest, TranslateResponse } from "../lib/messages";
import { renderResult, showError, showLoading, showPartial } from "../lib/render";

const MAX_LEN = 5000;
const MARGIN = 8; // min distance from viewport edges
const TRIGGER_SIZE = 24;
const CONTEXT_LOST_MSG = "扩展已更新，请刷新页面后重试";

/** Selection box in document coordinates, so it stays valid if the page scrolls. */
interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Single host element + shadow root reused for both the trigger and the bubble,
// so page styles can't leak in and our styles can't leak out.
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let lastText = "";
// Set when the user presses on our trigger; the click's trailing mouseup would
// otherwise re-read the (still active) selection and replace the bubble with a
// fresh trigger — which looked like the bubble "auto-closing".
let suppressNextMouseup = false;

function ensureHost(): ShadowRoot {
  if (host && shadow) {
    // Some SPAs wipe and rebuild the DOM; re-attach if we were thrown out.
    if (!host.isConnected) document.documentElement.appendChild(host);
    return shadow;
  }
  host = document.createElement("div");
  // Zero-size box at the document origin. Attached to <html> rather than
  // <body>: a positioned <body> with margins/transforms would otherwise shift
  // our absolute coordinates.
  host.style.cssText =
    "all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible;";
  shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = bubbleCss;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);
  return shadow;
}

function clearUi(): void {
  if (!shadow) return;
  // Remove everything except the <style> element.
  shadow.querySelectorAll(".yd-trigger, .yd-bubble").forEach((el) => el.remove());
}

function hasBubble(): boolean {
  return !!shadow?.querySelector(".yd-bubble");
}

function anchorOf(rect: DOMRect): Anchor {
  const sx = window.scrollX;
  const sy = window.scrollY;
  return { left: rect.left + sx, top: rect.top + sy, right: rect.right + sx, bottom: rect.bottom + sy };
}

function viewport(): { sx: number; sy: number; vw: number; vh: number } {
  return {
    sx: window.scrollX,
    sy: window.scrollY,
    vw: document.documentElement.clientWidth,
    vh: document.documentElement.clientHeight,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function setPos(el: HTMLElement, left: number, top: number): void {
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function placeTrigger(trigger: HTMLElement, a: Anchor): void {
  const { sx, sy, vw, vh } = viewport();
  const left = clamp(a.right - 4, sx + MARGIN, sx + vw - TRIGGER_SIZE - MARGIN);
  let top = a.bottom + 4;
  // No room below the selection → sit above it.
  if (top + TRIGGER_SIZE > sy + vh - MARGIN) top = a.top - 4 - TRIGGER_SIZE;
  top = Math.max(top, sy + MARGIN);
  setPos(trigger, left, top);
}

/**
 * Position the bubble next to the selection, kept inside the viewport. The
 * side (below/above) is decided once per bubble so a result that grows while
 * streaming doesn't jump around; horizontal clamping is recomputed every time
 * because the bubble's width depends on its content.
 */
function layoutBubble(bubble: HTMLElement, a: Anchor): void {
  const { sx, sy, vw, vh } = viewport();
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;

  const left = clamp(a.left, sx + MARGIN, Math.max(sx + MARGIN, sx + vw - w - MARGIN));

  let side = bubble.dataset.side;
  if (!side) {
    const est = Math.max(h, 200); // the loading state is tiny; plan for a real result
    const spaceBelow = sy + vh - (a.bottom + MARGIN);
    const spaceAbove = a.top - MARGIN - sy;
    side = est <= spaceBelow || spaceBelow >= spaceAbove ? "below" : "above";
    bubble.dataset.side = side;
  }
  let top = side === "below" ? a.bottom + MARGIN : a.top - MARGIN - h;
  top = Math.max(top, sy + MARGIN);
  setPos(bubble, left, top);
}

function showTrigger(a: Anchor): void {
  const root = ensureHost();
  clearUi();
  const trigger = document.createElement("div");
  trigger.className = "yd-trigger";
  trigger.textContent = "译";
  trigger.title = "翻译选中文本";
  placeTrigger(trigger, a);
  trigger.addEventListener("mousedown", (e) => {
    // Prevent clearing the selection / dismissing before we read it, and ignore
    // the trailing mouseup so it doesn't re-trigger over the new bubble.
    e.preventDefault();
    e.stopPropagation();
    suppressNextMouseup = true;
    void runTranslation(a);
  });
  root.appendChild(trigger);
}

function buildBubble(): HTMLDivElement {
  const root = ensureHost();
  clearUi();
  const bubble = document.createElement("div");
  bubble.className = "yd-bubble";
  // Keep clicks inside the bubble from dismissing it.
  bubble.addEventListener("mousedown", (e) => e.stopPropagation());
  root.appendChild(bubble);
  return bubble;
}

// True while the extension context backing this content script is still alive.
// After the extension is reloaded/updated, already-injected scripts keep running
// but lose their context — any chrome.* call then throws "Extension context
// invalidated". We detect that and ask the user to refresh instead.
function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function isContextInvalidated(msg: string): boolean {
  return /Extension context invalidated/i.test(msg);
}

/**
 * Ask the background for a translation over a dedicated port. `onPartial` is
 * called with the accumulated text as the machine translation streams in.
 */
function requestTranslation(
  text: string,
  onPartial: (tgt: string) => void,
): Promise<TranslateResponse> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: "translate" });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let settled = false;
    const finish = (r: TranslateResponse): void => {
      if (settled) return;
      settled = true;
      resolve(r);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    };
    port.onMessage.addListener((ev: TranslateEvent) => {
      if (ev.type === "partial") onPartial(ev.tgt);
      else if (ev.type === "done") finish({ ok: true, data: ev.data });
      else finish({ ok: false, error: ev.error });
    });
    port.onDisconnect.addListener(() => {
      finish({ ok: false, error: chrome.runtime.lastError?.message ?? "与扩展后台的连接已断开" });
    });
    const req: TranslateRequest = { type: "translate", text };
    port.postMessage(req);
  });
}

async function runTranslation(a: Anchor): Promise<void> {
  const text = lastText;
  if (!text) return;
  const bubble = buildBubble();
  // The bubble may be dismissed while we await; never touch it after that.
  const live = (): boolean => !!shadow?.contains(bubble);

  if (!contextAlive()) {
    showError(bubble, CONTEXT_LOST_MSG);
    layoutBubble(bubble, a);
    return;
  }

  showLoading(bubble);
  layoutBubble(bubble, a);

  // Coalesce streamed chunks into one DOM update per frame.
  let pending: string | null = null;
  let raf = 0;
  const onPartial = (tgt: string): void => {
    pending = tgt;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (pending === null || !live()) return;
      showPartial(bubble, pending);
      layoutBubble(bubble, a);
    });
  };

  const resp = await requestTranslation(text, onPartial);
  if (raf) cancelAnimationFrame(raf);
  if (!live()) return;

  if (!resp.ok) {
    showError(bubble, isContextInvalidated(resp.error) ? CONTEXT_LOST_MSG : `翻译失败：${resp.error}`);
  } else {
    renderResult(bubble, resp.data);
  }
  layoutBubble(bubble, a);
}

function isInsideUi(target: EventTarget | null): boolean {
  return !!host && target instanceof Node && host.contains(target);
}

// Read the current selection and show the trigger for it (or clear our UI if
// there is nothing worth translating).
function onSelectionSettled(): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? "";
  // Skip selections without a single letter (numbers, punctuation, whitespace).
  if (!sel || sel.rangeCount === 0 || !text || text.length > MAX_LEN || !/\p{L}/u.test(text)) {
    if (!isInsideUi(document.activeElement)) clearUi();
    return;
  }
  // Same text and its bubble is already open (e.g. a stray Shift keyup while
  // reading the result): leave it alone.
  if (text === lastText && hasBubble()) return;
  lastText = text;
  showTrigger(anchorOf(sel.getRangeAt(0).getBoundingClientRect()));
}

document.addEventListener("mouseup", (e) => {
  if (suppressNextMouseup) {
    suppressNextMouseup = false;
    return;
  }
  if (isInsideUi(e.target)) return;
  // Let the browser finalize the selection first.
  setTimeout(onSelectionSettled, 0);
});

// Keyboard selections (Shift+Arrow / Shift+Home…): act when Shift is released.
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && !isInsideUi(e.target)) setTimeout(onSelectionSettled, 0);
});

// Dismiss on outside interaction. The UI is positioned in document coordinates
// (left/top include scrollX/scrollY), so it scrolls naturally with the page —
// we intentionally do NOT dismiss on scroll, which previously closed the bubble
// when selecting text near a viewport edge triggered an auto-scroll.
document.addEventListener("mousedown", (e) => {
  if (!isInsideUi(e.target)) clearUi();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearUi();
});
