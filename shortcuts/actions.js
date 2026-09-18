// actions.js — shared action registry, defaults, and config helpers.
// Imported as an ES module by background.js, popup.js, and options.js.
// Key-combo helpers live in keys.js so content.js can share the exact same
// implementation without duplicating it.

import './keys.js';

const { comboFromEvent, comboLabel, parseCombo, isModifierKey, isUnsafePrefix } =
  globalThis.ShortcutKeys;

export { comboFromEvent, comboLabel, parseCombo, isModifierKey, isUnsafePrefix };

export const CONFIG_KEY = 'config';
export const META_KEY = 'actionMeta';
const HISTORY_KEY = 'tabHistory';
const HISTORY_DEPTH = 8;

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

// Resolve the window the chord should act on: the sender's window when the
// message came from a content script, otherwise the last-focused window.
async function targetWindowId(ctx) {
  if (ctx?.tab?.windowId != null) return ctx.tab.windowId;
  const win = await chrome.windows.getLastFocused();
  return win.id;
}

// Re-query the active tab so index/pinned/mutedInfo are current (sender.tab is
// a snapshot from when the message was sent).
async function currentTab(ctx) {
  const windowId = await targetWindowId(ctx);
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!active) throw new Error('no active tab in window ' + windowId);
  return active;
}

async function tabsInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.sort((a, b) => a.index - b.index);
}

// Short origin label for the tab picker: "github.com" for web pages, the bare
// scheme ("chrome", "file") for everything else.
function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? u.hostname.replace(/^www\./, '')
      : u.protocol.slice(0, -1);
  } catch {
    return '';
  }
}

export async function activateTab(tabId, fromWindowId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  await chrome.tabs.update(tabId, { active: true });
  // The tab may have been dragged to another window since we recorded it;
  // activating alone would leave that window in the background.
  if (tab.windowId !== fromWindowId) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return true;
}

// Move the current tab by `delta` places among its own peers. Pinned and
// unpinned tabs live in separate strips — Chrome refuses to interleave them —
// so we only ever move within the strip the tab already belongs to.
async function moveBy(ctx, delta) {
  const t = await currentTab(ctx);
  const tabs = await tabsInWindow(t.windowId);
  const peers = tabs.filter((x) => x.pinned === t.pinned);
  if (peers.length < 2) return;
  const i = peers.findIndex((x) => x.id === t.id);
  if (i === -1) return;
  const target = peers[(i + delta + peers.length) % peers.length];
  if (target.id === t.id) return;
  await chrome.tabs.move(t.id, { index: target.index });
}

// ---------------------------------------------------------------------------
// Last-tab history, persisted in storage.session so it survives the service
// worker being torn down and restarted within a browser session.
//
// Every read and write goes through one promise chain. chrome.tabs.onActivated
// can fire faster than a get/set round-trip completes, and unserialised
// read-modify-write cycles silently drop entries when they interleave.
// ---------------------------------------------------------------------------

let historyChain = Promise.resolve();

// Run `task` after every previously queued history operation has settled.
function queue(task) {
  const run = historyChain.then(task);
  // Keep the chain alive even if one operation throws, or every later
  // operation queued behind it would reject too.
  historyChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function readHistory(fn) {
  return queue(async () => {
    const stored = await chrome.storage.session.get(HISTORY_KEY);
    return fn(stored[HISTORY_KEY] || {});
  });
}

// `fn` mutates the history object in place; returning false means "unchanged,
// skip the write".
function updateHistory(fn) {
  return queue(async () => {
    const stored = await chrome.storage.session.get(HISTORY_KEY);
    const hist = stored[HISTORY_KEY] || {};
    if (fn(hist) === false) return;
    await chrome.storage.session.set({ [HISTORY_KEY]: hist });
  });
}

export function recordActivation(windowId, tabId) {
  return updateHistory((hist) => {
    const list = (hist[windowId] || []).filter((id) => id !== tabId);
    list.unshift(tabId);
    hist[windowId] = list.slice(0, HISTORY_DEPTH);
  });
}

export function forgetTab(tabId) {
  return updateHistory((hist) => {
    let changed = false;
    for (const wid of Object.keys(hist)) {
      const filtered = hist[wid].filter((id) => id !== tabId);
      if (filtered.length !== hist[wid].length) {
        hist[wid] = filtered;
        changed = true;
      }
    }
    return changed;
  });
}

// Windows are never reopened, so their history is dead weight in session
// storage once they close.
export function forgetWindow(windowId) {
  return updateHistory((hist) => {
    if (!(windowId in hist)) return false;
    delete hist[windowId];
  });
}

function previousTab(windowId) {
  return readHistory((hist) => (hist[windowId] || [])[1] ?? null);
}

// ---------------------------------------------------------------------------
// Action registry: id -> { label, description, defaultKey, run(ctx) }
// ---------------------------------------------------------------------------

export const ACTIONS = {
  'last-tab': {
    label: 'Switch to last tab',
    description: 'Jump to the previously focused tab (toggle back and forth).',
    defaultKey: 'l',
    async run(ctx) {
      const windowId = await targetWindowId(ctx);
      const prev = await previousTab(windowId);
      if (prev == null) return;
      // If the tab is gone, drop it so the next press tries the one before it.
      if (!(await activateTab(prev, windowId))) await forgetTab(prev);
    },
  },

  'next-tab': {
    label: 'Next tab',
    description: 'Activate the tab to the right (wraps around).',
    defaultKey: 'n',
    async run(ctx) {
      const t = await currentTab(ctx);
      const tabs = await tabsInWindow(t.windowId);
      const i = tabs.findIndex((x) => x.id === t.id);
      if (i === -1 || tabs.length < 2) return;
      await chrome.tabs.update(tabs[(i + 1) % tabs.length].id, { active: true });
    },
  },

  'prev-tab': {
    label: 'Previous tab',
    description: 'Activate the tab to the left (wraps around).',
    defaultKey: 'p',
    async run(ctx) {
      const t = await currentTab(ctx);
      const tabs = await tabsInWindow(t.windowId);
      const i = tabs.findIndex((x) => x.id === t.id);
      if (i === -1 || tabs.length < 2) return;
      await chrome.tabs.update(tabs[(i - 1 + tabs.length) % tabs.length].id, {
        active: true,
      });
    },
  },

  'first-tab': {
    label: 'First tab',
    description: 'Activate the leftmost tab.',
    defaultKey: 'g',
    async run(ctx) {
      const tabs = await tabsInWindow(await targetWindowId(ctx));
      if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
    },
  },

  'last-position-tab': {
    label: 'Last tab (rightmost)',
    description: 'Activate the rightmost tab.',
    defaultKey: 'e',
    async run(ctx) {
      const tabs = await tabsInWindow(await targetWindowId(ctx));
      if (tabs.length) {
        await chrome.tabs.update(tabs[tabs.length - 1].id, { active: true });
      }
    },
  },

  'choose-tab': {
    label: 'Choose tab',
    description:
      'List the tabs in this window: Ctrl+N / Ctrl+P (or ↓ / ↑) to move, Enter to switch, Esc to cancel.',
    defaultKey: 'w',
    // Unlike the other actions this one only gathers data. The list is drawn,
    // and the choice made, in the page by content.js, which then asks for the
    // chosen tab with an "activate-tab" message.
    async run(ctx) {
      const tabs = await tabsInWindow(await targetWindowId(ctx));
      return {
        tabs: tabs.map((t) => ({
          id: t.id,
          title: t.title || t.url || '',
          host: hostOf(t.url),
          active: t.active,
          pinned: t.pinned,
        })),
      };
    },
  },

  'new-tab': {
    label: 'New tab',
    description: 'Open a new tab.',
    defaultKey: 'c',
    async run(ctx) {
      await chrome.tabs.create({ windowId: await targetWindowId(ctx) });
    },
  },

  'close-tab': {
    label: 'Close tab',
    description: 'Close the current tab.',
    defaultKey: 'x',
    async run(ctx) {
      const t = await currentTab(ctx);
      await chrome.tabs.remove(t.id);
    },
  },

  'reopen-tab': {
    label: 'Reopen closed tab',
    description: 'Restore the most recently closed tab/window.',
    defaultKey: 'u',
    async run() {
      await chrome.sessions.restore();
    },
  },

  'duplicate-tab': {
    label: 'Duplicate tab',
    description: 'Duplicate the current tab.',
    defaultKey: 'd',
    async run(ctx) {
      const t = await currentTab(ctx);
      await chrome.tabs.duplicate(t.id);
    },
  },

  'reload-tab': {
    label: 'Reload tab',
    description: 'Reload the current tab.',
    defaultKey: 'r',
    async run(ctx) {
      const t = await currentTab(ctx);
      await chrome.tabs.reload(t.id);
    },
  },

  'mute-tab': {
    label: 'Toggle mute',
    description: 'Mute or unmute the current tab.',
    defaultKey: 'm',
    async run(ctx) {
      const t = await currentTab(ctx);
      await chrome.tabs.update(t.id, { muted: !t.mutedInfo?.muted });
    },
  },

  'pin-tab': {
    label: 'Toggle pin',
    description: 'Pin or unpin the current tab.',
    defaultKey: 'i',
    async run(ctx) {
      const t = await currentTab(ctx);
      await chrome.tabs.update(t.id, { pinned: !t.pinned });
    },
  },

  'move-tab-left': {
    label: 'Move tab left',
    description: 'Move the current tab one position to the left (wraps around).',
    defaultKey: ',',
    async run(ctx) {
      await moveBy(ctx, -1);
    },
  },

  'move-tab-right': {
    label: 'Move tab right',
    description: 'Move the current tab one position to the right (wraps around).',
    defaultKey: '.',
    async run(ctx) {
      await moveBy(ctx, 1);
    },
  },
};

export const ACTION_IDS = Object.keys(ACTIONS);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const TIMEOUT_MIN = 300;
export const TIMEOUT_MAX = 10000;

export const DEFAULT_CONFIG = {
  enabled: true,
  ignoreInInputs: false, // when true, the prefix is ignored while typing in inputs
  showCheatsheet: true, // show the shortcut list when the prefix is pressed
  timeoutMs: 3000, // how long prefix mode waits for the second key (ms)
  prefix: 'Ctrl+a',
  bindings: Object.fromEntries(
    Object.entries(ACTIONS).map(([id, a]) => [a.defaultKey, id]),
  ),
  // Action ids this config has already been offered a default binding for.
  // Lets an upgrade bind genuinely new actions without resurrecting ones the
  // user deliberately cleared.
  knownActions: Object.keys(ACTIONS),
};

// Fill in fields a config saved by an older version is missing, and drop
// bindings that point at actions which no longer exist. Pure — never writes.
export function normalizeConfig(stored) {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!stored || typeof stored !== 'object') return base;

  const cfg = { ...base, ...stored };
  cfg.enabled = stored.enabled !== false;
  cfg.ignoreInInputs = stored.ignoreInInputs === true;
  cfg.showCheatsheet = stored.showCheatsheet !== false;

  const t = Number(stored.timeoutMs);
  cfg.timeoutMs = Number.isFinite(t)
    ? Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(t)))
    : base.timeoutMs;

  cfg.prefix =
    typeof stored.prefix === 'string' && stored.prefix ? stored.prefix : base.prefix;

  const bindings =
    stored.bindings && typeof stored.bindings === 'object' ? stored.bindings : base.bindings;
  cfg.bindings = {};
  for (const [combo, id] of Object.entries(bindings)) {
    if (combo && ACTIONS[id]) cfg.bindings[combo] = id;
  }

  cfg.knownActions = Array.isArray(stored.knownActions)
    ? stored.knownActions.filter((id) => typeof id === 'string')
    : // A config from before this field existed has, by definition, already
      // seen every action defined at the time it was written. Assume that is
      // all of today's actions so nothing the user cleared comes back.
      [...ACTION_IDS];

  return cfg;
}

// True when a stored config already matches the normalized one, so the
// background worker can skip a pointless write (and the storage.onChanged
// broadcast to every content script) on each browser start.
function sameConfig(a, b) {
  if (!b || typeof b !== 'object') return false;
  for (const k of ['enabled', 'ignoreInInputs', 'showCheatsheet', 'timeoutMs', 'prefix']) {
    if (a[k] !== b[k]) return false;
  }
  if (!b.bindings || typeof b.bindings !== 'object') return false;
  const ak = Object.keys(a.bindings);
  if (ak.length !== Object.keys(b.bindings).length) return false;
  for (const k of ak) if (a.bindings[k] !== b.bindings[k]) return false;

  if (!Array.isArray(b.knownActions) || a.knownActions.length !== b.knownActions.length) {
    return false;
  }
  const known = new Set(b.knownActions);
  return a.knownActions.every((id) => known.has(id));
}

// Give actions added since this config was last written their default binding,
// as long as that key is still free. Returns { config, changed }.
export function migrateConfig(stored) {
  const config = normalizeConfig(stored);
  const known = new Set(config.knownActions);
  let addedAction = false;

  // 0.3.0 gave "w" to the tab picker and moved "close tab" to "x", as in tmux.
  // Follow along for a config that predates the picker and still has the old
  // default in place — and only then: a key the user chose is theirs to keep.
  if (
    !known.has('choose-tab') &&
    config.bindings.w === 'close-tab' &&
    !config.bindings.x &&
    config.prefix !== 'x'
  ) {
    delete config.bindings.w;
    config.bindings.x = 'close-tab';
  }

  for (const id of ACTION_IDS) {
    if (known.has(id)) continue;
    known.add(id);
    const key = ACTIONS[id].defaultKey;
    if (key && !config.bindings[key] && key !== config.prefix) {
      config.bindings[key] = id;
    }
    addedAction = true;
  }
  config.knownActions = [...known].filter((id) => ACTIONS[id]);

  return { config, changed: addedAction || !sameConfig(config, stored) };
}
