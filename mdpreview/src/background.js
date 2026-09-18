import { LIB_FILES } from './core/libs.js';

const MENU_RENDER_PAGE = 'render-page';
const MENU_PREVIEW_SELECTION = 'preview-selection';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_RENDER_PAGE,
      title: chrome.i18n.getMessage('menuRenderPage'),
      contexts: ['page'],
      documentUrlPatterns: ['file:///*', 'http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: MENU_PREVIEW_SELECTION,
      title: chrome.i18n.getMessage('menuPreviewSelection'),
      contexts: ['selection'],
    });
  });
  // Local files only render once the user enables "Allow access to file URLs";
  // the options page explains how.
  if (reason === 'install' && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab?.id == null) return;
  const target = { tabId: tab.id, frameIds: [info.frameId ?? 0] };
  try {
    if (info.menuItemId === MENU_RENDER_PAGE) {
      await chrome.scripting.executeScript({ target, files: ['viewer.js'] });
    } else if (info.menuItemId === MENU_PREVIEW_SELECTION) {
      await previewSelection(target, tab, info.selectionText ?? '');
    }
  } catch (err) {
    console.warn('[Markdown Preview]', err);
  }
});

// info.selectionText loses line breaks, so read the selection from the page
// when we can and hand it to the editor through session storage.
async function previewSelection(target, tab, fallback) {
  let text = fallback;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: () => getSelection()?.toString() ?? '',
    });
    if (injection?.result) text = injection.result;
  } catch {
    // No access to this page; keep the flattened selection text.
  }
  await chrome.storage.session.set({ editorImport: text });
  await chrome.tabs.create({
    url: chrome.runtime.getURL('editor.html?import=selection'),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

const handlers = {
  async 'mdp:inject'(message, sender) {
    await chrome.scripting.executeScript({ target: frameTarget(sender), files: ['viewer.js'] });
    return { ok: true };
  },

  async 'mdp:load-lib'({ lib }, sender) {
    const file = LIB_FILES[lib];
    if (!file) throw new Error(`Unknown library: ${lib}`);
    await chrome.scripting.executeScript({ target: frameTarget(sender), files: [file] });
    return { ok: true };
  },

  // Re-reads the sender's own document so the viewer can watch local files for
  // changes (content scripts cannot fetch file:// URLs themselves). Returns the
  // text only when its hash differs from the one the viewer already has.
  async 'mdp:fetch'({ charset, hash }, sender) {
    const url = new URL(sender.url);
    url.hash = '';
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const digest = await sha256(bytes);
    if (digest === hash) return { hash: digest };
    return { hash: digest, text: decode(bytes, charset) };
  },

  async 'mdp:open-options'() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler || !sender.tab) return false;
  handler(message, sender).then(sendResponse, (err) => sendResponse({ error: err?.message ?? String(err) }));
  return true;
});

function frameTarget(sender) {
  return sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [sender.frameId] };
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Decode with the charset the page was rendered with so the text matches.
function decode(bytes, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
