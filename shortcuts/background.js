// background.js — service worker. Performs tab operations on behalf of the
// content script and tracks tab-activation history for the "last tab" action.

import {
  ACTIONS,
  CONFIG_KEY,
  META_KEY,
  activateTab,
  migrateConfig,
  recordActivation,
  forgetTab,
  forgetWindow,
} from './actions.js';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Seed/upgrade the stored config, publish action labels for the content-script
// cheatsheet, and seed the history with the currently-active tabs so "last tab"
// has something to work with after a fresh start.
async function init() {
  const stored = await chrome.storage.sync.get(CONFIG_KEY);
  const { config, changed } = migrateConfig(stored[CONFIG_KEY]);
  if (changed) await chrome.storage.sync.set({ [CONFIG_KEY]: config });

  const actionMeta = Object.fromEntries(
    Object.entries(ACTIONS).map(([id, a]) => [id, a.label]),
  );
  await chrome.storage.local.set({ [META_KEY]: actionMeta });

  const activeTabs = await chrome.tabs.query({ active: true });
  for (const t of activeTabs) {
    if (t.id != null) await recordActivation(t.windowId, t.id);
  }
}

// Content scripts declared in the manifest only run on documents loaded after
// the extension was installed or reloaded. Without this, every tab that was
// already open stays dead until the user reloads it — which reads as "the
// extension doesn't work".
async function injectIntoOpenTabs() {
  const [spec] = chrome.runtime.getManifest().content_scripts;
  if (!spec?.js?.length) return;

  const tabs = await chrome.tabs.query({
    url: ['http://*/*', 'https://*/*', 'file://*/*'],
  });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: spec.all_frames === true },
          files: spec.js,
          injectImmediately: true,
        });
      } catch {
        // Restricted page (chrome://, the Web Store, a PDF viewer, …).
        // Nothing to do — those pages can never run content scripts.
      }
    }),
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  await init();
  await injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(init);

// ---------------------------------------------------------------------------
// Tab-activation history
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  recordActivation(windowId, tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
});
chrome.windows.onRemoved.addListener((windowId) => {
  forgetWindow(windowId);
});

// ---------------------------------------------------------------------------
// Messages from content scripts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Relay a UI request from a subframe up to the tab's top frame, which is the
  // only one that can draw an overlay the user will actually see.
  if (msg?.type === 'ui') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.tabs
        .sendMessage(tabId, { type: 'ui', payload: msg.payload }, { frameId: 0 })
        .catch(() => {});
    }
    return; // fire-and-forget
  }

  // The tab picker's choice. It is a message of its own rather than an action
  // because it carries an argument, and because it must not be bindable.
  if (msg?.type === 'activate-tab') {
    activateTab(msg.tabId, sender.tab?.windowId)
      .then((found) =>
        sendResponse(found ? { ok: true } : { ok: false, error: 'That tab is gone' }),
      )
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type !== 'run-action') return;

  const action = ACTIONS[msg.actionId];
  if (!action) {
    sendResponse({ ok: false, error: `unknown action: ${msg.actionId}` });
    return;
  }

  // Most actions return nothing; the tab picker returns the list to draw.
  Promise.resolve(action.run({ tab: sender.tab, sender }))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // keep the message channel open for the async response
});
