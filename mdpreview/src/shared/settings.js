// User settings. Everything lives in chrome.storage.sync except customCss,
// which can exceed the sync per-item quota and is kept in chrome.storage.local.

export const DEFAULTS = /* @__PURE__ */ Object.freeze({
  enabled: true,
  renderLocal: true,
  renderRemote: true,
  theme: 'auto', // 'auto' | 'light' | 'dark'
  width: 'normal', // 'narrow' | 'normal' | 'wide' | 'full'
  fontSize: 16,
  toc: true,
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  emoji: true,
  math: true,
  mermaid: true,
  autoReload: true,
  reloadInterval: 1000,
});

const LOCAL_DEFAULTS = /* @__PURE__ */ Object.freeze({ customCss: '' });

export const WIDTHS = /* @__PURE__ */ Object.freeze({ narrow: '760px', normal: '920px', wide: '1200px', full: 'none' });

// Settings that change how Markdown is parsed; a change requires a re-render.
export const MARKDOWN_KEYS = ['html', 'linkify', 'breaks', 'typographer', 'emoji', 'math', 'mermaid'];

export async function loadSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS),
  ]);
  return { ...DEFAULTS, ...sync, ...local };
}

export async function saveSettings(patch) {
  const sync = {};
  const local = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in LOCAL_DEFAULTS) local[key] = value;
    else if (key in DEFAULTS) sync[key] = value;
  }
  await Promise.all([
    Object.keys(sync).length && chrome.storage.sync.set(sync),
    Object.keys(local).length && chrome.storage.local.set(local),
  ]);
}

export async function resetSettings() {
  await Promise.all([
    chrome.storage.sync.remove(Object.keys(DEFAULTS)),
    chrome.storage.local.remove(Object.keys(LOCAL_DEFAULTS)),
  ]);
}

// Calls listener(changedKeys, settings) whenever a setting changes anywhere.
export function onSettingsChanged(listener) {
  const handler = (changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => k in DEFAULTS || k in LOCAL_DEFAULTS);
    if (keys.length) loadSettings().then((settings) => listener(keys, settings));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
