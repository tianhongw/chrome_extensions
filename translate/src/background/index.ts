import { translate } from "../lib/youdao";
import { cacheGet, cacheSet } from "../lib/cache";
import { sessionSet } from "../lib/session-store";
import type {
  ResultPayload,
  TranslateEvent,
  TranslateRequest,
  TranslateResponse,
} from "../lib/messages";

// Identical texts requested while a translation is still in flight share the
// same promise instead of hitting the network twice.
const inflight = new Map<string, Promise<TranslateResponse>>();

async function handleTranslate(
  text: string,
  onPartial?: (tgt: string) => void,
): Promise<TranslateResponse> {
  const key = text.trim();
  if (!key) return { ok: false, error: "没有选中文本" };

  const cached = await cacheGet(key);
  if (cached) return { ok: true, data: cached };

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<TranslateResponse> => {
    try {
      const data = await translate(key, onPartial);
      await cacheSet(key, data);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

// --- Content-script clients (long-lived port per request) -----------------
// A port lets us stream partial output while the LLM is still generating, and
// keeps the service worker alive for the duration of the request.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const send = (ev: TranslateEvent): void => {
    if (!open) return;
    try {
      port.postMessage(ev);
    } catch {
      open = false;
    }
  };

  port.onMessage.addListener((msg: TranslateRequest) => {
    if (msg?.type !== "translate" || typeof msg.text !== "string") return;
    void handleTranslate(msg.text, (tgt) => send({ type: "partial", tgt })).then((resp) => {
      send(resp.ok ? { type: "done", data: resp.data } : { type: "error", error: resp.error });
    });
  });
});

// --- Context menu ---------------------------------------------------------
// The floating-bubble flow relies on window.getSelection(), which is empty
// inside Chrome's built-in PDF viewer (the selection lives in an out-of-process
// plugin). The context menu, however, receives info.selectionText even there —
// so this is what makes selection translation work on PDFs. We show the result
// in a small popup window: notifications are unreliable (silently dropped when
// the OS denies Chrome notification permission) and we can't inject a bubble
// into the PDF viewer's page.
const MENU_ID = "yd-translate-selection";
const RESULT_URL = "result.html";
const RESULT_W = 400;
const RESULT_H = 560;

let resultWindowId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: a leftover menu from a previous install would make
  // create() fail with "duplicate id".
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '有道翻译："%s"',
      contexts: ["selection"],
    });
  });
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === resultWindowId) resultWindowId = null;
});

// Center the popup over the browser window that triggered it.
async function centerOver(sourceWindowId?: number): Promise<{ left?: number; top?: number }> {
  if (sourceWindowId === undefined) return {};
  try {
    const w = await chrome.windows.get(sourceWindowId);
    if (w.left != null && w.top != null && w.width && w.height) {
      return {
        left: Math.round(w.left + (w.width - RESULT_W) / 2),
        top: Math.round(w.top + (w.height - RESULT_H) / 2),
      };
    }
  } catch {
    /* fall back to the browser's default placement */
  }
  return {};
}

async function showResultWindow(sourceWindowId?: number): Promise<void> {
  const pos = await centerOver(sourceWindowId);
  if (resultWindowId !== null) {
    try {
      await chrome.windows.update(resultWindowId, {
        focused: true,
        drawAttention: true,
        ...pos,
      });
      return;
    } catch {
      resultWindowId = null; // window was closed; fall through and recreate
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(RESULT_URL),
    type: "popup",
    width: RESULT_W,
    height: RESULT_H,
    ...pos,
  });
  resultWindowId = win.id ?? null;
}

const setResult = (payload: ResultPayload): Promise<void> => sessionSet("lastResult", payload);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = info.selectionText?.trim();
  if (!text) return;

  // Show the window immediately in a loading state, then fill in the result.
  await setResult({ loading: true, query: text });
  await showResultWindow(tab?.windowId);

  // Stream partial output to the window, throttled so we don't hammer storage.
  let lastPush = 0;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const pushPartial = (tgt: string): void => {
    const now = Date.now();
    if (pushTimer) clearTimeout(pushTimer);
    const wait = Math.max(0, 80 - (now - lastPush));
    pushTimer = setTimeout(() => {
      pushTimer = null;
      lastPush = Date.now();
      void setResult({ loading: true, query: text, partial: tgt });
    }, wait);
  };

  const resp = await handleTranslate(text, pushPartial);
  if (pushTimer) clearTimeout(pushTimer);
  await setResult(resp.ok ? { data: resp.data } : { error: resp.error });
});
