// content.js — runs on every page and every frame. Captures the prefix key,
// enters "prefix mode", then maps the next key to an action and asks the
// background worker to run it.
//
// Content scripts can't import ES modules, so the shared key helpers arrive via
// keys.js, which the manifest lists immediately before this file.
(() => {
  // A previous instance may still be listening: either this file was injected
  // twice, or the extension was reloaded and left an orphan behind. Evict it
  // before installing ourselves.
  if (typeof globalThis.__shortcutsTeardown === 'function') {
    try {
      globalThis.__shortcutsTeardown();
    } catch {
      /* orphan from a dead context */
    }
  }

  const { comboFromEvent, comboLabel, parseCombo, isModifierKey } = globalThis.ShortcutKeys;

  const CONFIG_KEY = 'config';
  const META_KEY = 'actionMeta';
  const FLASH_MS = 900;
  // Mirrors DEFAULT_CONFIG in actions.js. Only used to keep a malformed config
  // (e.g. one synced in from an older version of the extension) from leaving
  // this frame silently inert until the background worker normalises it.
  const FALLBACK_PREFIX = 'Ctrl+a';
  // Mirrors the id in actions.js. The picker is the one action that runs in
  // the page instead of the background worker: the worker only supplies the
  // tab list, and the choice goes back as an "activate-tab" message.
  const PICKER_ACTION = 'choose-tab';

  const PANEL_BG = '#111827';
  const OK_BG = '#14532d';
  const ERR_BG = '#7f1d1d';

  const isTopFrame = window === window.top;

  let config = null;
  let labels = {}; // actionId -> human label, published by the background worker
  let prefixActive = false;
  let picker = null; // { tabs, index } while the tab picker is open
  let prefixTimer = null;
  let flashTimer = null;
  let indicator = null;

  // Physical keys whose keydown we swallowed, so we can swallow the matching
  // keyup too. Without this the page still sees the keyup and fires its own
  // single-key shortcuts for the chord key we just consumed.
  const swallowed = new Set();

  // --- extension plumbing ----------------------------------------------------

  // After the extension is reloaded or updated, this script keeps running but
  // chrome.runtime is dead. Detect that and get out of the way, or we would go
  // on eating the prefix key on every page while doing nothing with it.
  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // --- config ---------------------------------------------------------------
  let configRequested = false;

  function setConfig(raw) {
    config =
      raw && typeof raw === 'object'
        ? { ...raw, prefix: raw.prefix || FALLBACK_PREFIX, bindings: raw.bindings || {} }
        : null;
  }

  function loadConfig() {
    if (configRequested || !alive()) return;
    configRequested = true;
    chrome.storage.sync.get(CONFIG_KEY, (res) => {
      if (chrome.runtime.lastError) return;
      setConfig(res?.[CONFIG_KEY]);
    });
    if (isTopFrame) {
      chrome.storage.local.get(META_KEY, (res) => {
        if (chrome.runtime.lastError) return;
        labels = res?.[META_KEY] || {};
      });
    }
  }

  function onStorageChanged(changes, area) {
    if (area === 'sync' && changes[CONFIG_KEY]) {
      setConfig(changes[CONFIG_KEY].newValue);
      configRequested = true;
      if (!config || !config.enabled) {
        exitPrefix();
        closePicker();
      }
    }
    if (area === 'local' && changes[META_KEY]) {
      labels = changes[META_KEY].newValue || {};
    }
  }

  // A frame that never takes focus can never receive a chord, so on pages with
  // many iframes we skip the storage round-trip until the frame wakes up.
  const wake = () => {
    window.removeEventListener('focus', wake, true);
    window.removeEventListener('pointerdown', wake, true);
    loadConfig();
  };

  // --- binding lookup -------------------------------------------------------

  // Drop the prefix's own modifiers from a combo. Holding Ctrl while pressing
  // the second key (Ctrl+A then Ctrl+L, instead of releasing Ctrl first)
  // should behave like the plain "l", as in tmux.
  function withoutPrefixMods(combo) {
    const prefixMods = new Set(parseCombo(config?.prefix || '').mods);
    const { mods, key } = parseCombo(combo);
    return [...mods.filter((m) => !prefixMods.has(m)), key].join('+');
  }

  // Look up a binding for the second key: exact first, then with the prefix's
  // modifiers ignored.
  function matchBinding(combo) {
    const bindings = config?.bindings;
    if (!bindings) return undefined;
    return bindings[combo] || bindings[withoutPrefixMods(combo)];
  }

  // What a keystroke means inside the tab picker; null for "nothing". The
  // emacs-style Ctrl+N / Ctrl+P are the primary keys, with the arrows as a
  // fallback for platforms where Chrome reserves Ctrl+N for itself.
  function pickerCommand(combo) {
    const keys = new Set([combo, withoutPrefixMods(combo)]);
    if (keys.has('Ctrl+n') || keys.has('ArrowDown')) return 'down';
    if (keys.has('Ctrl+p') || keys.has('ArrowUp')) return 'up';
    if (keys.has('Enter')) return 'choose';
    if (keys.has('Escape') || keys.has('q')) return 'cancel';
    return null;
  }

  // composedPath()[0] rather than e.target: an event from inside a shadow root
  // is retargeted to the host, which would hide a web component's own <input>.
  function isEditable(e) {
    const el = (typeof e.composedPath === 'function' ? e.composedPath()[0] : null) || e.target;
    if (!el || !el.tagName) return false;
    return (
      el.isContentEditable === true ||
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT'
    );
  }

  // --- key handling ---------------------------------------------------------
  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowed.add(e.code || e.key);
  }

  function onKeyDown(e) {
    if (!alive()) return teardown();
    // Safety net for a frame that got focus without firing a focus event.
    if (!config) return loadConfig();
    if (!config.enabled) return;

    // The picker is modal: every key belongs to it while it is open, auto-
    // repeat included, so a held Ctrl+N keeps moving through the list.
    if (picker) {
      if (!(e.isComposing || e.keyCode === 229)) onPickerKey(e);
      return;
    }

    // Auto-repeat from a held-down key. Left unchecked, holding the prefix
    // enters prefix mode and the very next repeat is treated as the second key,
    // so the chord dies before the user can finish it.
    if (e.repeat) {
      // Also keep swallowing a chord key that is still held after firing, so
      // the page doesn't receive the tail of the repeat as its own keystrokes.
      if (prefixActive || swallowed.has(e.code || e.key)) consume(e);
      return;
    }
    // Mid-composition IME keystrokes belong to the input method, not to us.
    if (e.isComposing || e.keyCode === 229) return;
    if (isModifierKey(e.key)) return; // ignore lone modifier presses

    const combo = comboFromEvent(e);
    if (!combo) return;

    if (!prefixActive) {
      if (combo !== config.prefix) return;
      if (config.ignoreInInputs && isEditable(e)) return;
      consume(e);
      enterPrefix();
      return;
    }

    // In prefix mode: this keystroke belongs to us, swallow it.
    consume(e);

    if (e.key === 'Escape') {
      exitPrefix();
      return;
    }

    const actionId = matchBinding(combo);
    if (!actionId) {
      exitPrefix();
      return;
    }

    // Keep the panel up so what follows (the flash, or the picker) replaces it
    // without a blink.
    exitPrefix({ hide: false });
    if (actionId === PICKER_ACTION) {
      openPicker();
      return;
    }
    ui({ kind: 'flash', actionId });
    send({ type: 'run-action', actionId }).then((res) => {
      if (res && res.ok === false) ui({ kind: 'error', message: res.error });
    });
  }

  // Swallow the keyup of any key whose keydown we consumed.
  function onKeyUp(e) {
    const id = e.code || e.key;
    if (!swallowed.delete(id)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // A keyup delivered elsewhere (focus moved during the chord) would otherwise
  // leave stale entries behind forever.
  function onBlur() {
    swallowed.clear();
    closePicker();
  }

  // A click means the user has moved on; don't leave the modal picker up.
  function onPointerDown() {
    closePicker();
  }

  function enterPrefix() {
    prefixActive = true;
    clearTimeout(flashTimer);
    ui({ kind: config.showCheatsheet !== false ? 'cheatsheet' : 'header' });
    clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => exitPrefix(), config.timeoutMs || 3000);
  }

  function exitPrefix({ hide = true } = {}) {
    prefixActive = false;
    clearTimeout(prefixTimer);
    if (hide) ui({ kind: 'hide' });
  }

  // --- tab picker ------------------------------------------------------------
  // Modal, like tmux's choose-tree: the list stays up until Enter or Esc, and
  // nothing typed meanwhile reaches the page. State lives in the frame that
  // received the chord; the top frame only draws what it is told to.

  function openPicker() {
    send({ type: 'run-action', actionId: PICKER_ACTION }).then((res) => {
      if (!res || res.ok === false) {
        ui({ kind: 'error', message: res?.error });
        return;
      }
      const tabs = res.result?.tabs || [];
      if (tabs.length === 0) {
        ui({ kind: 'hide' });
        return;
      }
      picker = { tabs, index: Math.max(0, tabs.findIndex((t) => t.active)) };
      renderPicker();
    });
  }

  function renderPicker() {
    ui({ kind: 'picker', tabs: picker.tabs, index: picker.index });
  }

  function onPickerKey(e) {
    if (isModifierKey(e.key)) return;
    consume(e); // matched or not: nothing leaks to the page
    switch (pickerCommand(comboFromEvent(e))) {
      case 'down':
        movePicker(1);
        break;
      case 'up':
        movePicker(-1);
        break;
      case 'choose':
        choosePicker();
        break;
      case 'cancel':
        closePicker();
        break;
    }
  }

  function movePicker(delta) {
    const n = picker.tabs.length;
    picker.index = (picker.index + delta + n) % n;
    renderPicker();
  }

  function choosePicker() {
    const tab = picker.tabs[picker.index];
    closePicker();
    if (!tab) return;
    send({ type: 'activate-tab', tabId: tab.id }).then((res) => {
      if (res && res.ok === false) ui({ kind: 'error', message: res.error });
    });
  }

  function closePicker() {
    if (!picker) return;
    picker = null;
    ui({ kind: 'hide' });
  }

  // --- on-screen indicator ---------------------------------------------------
  // Only the top frame draws. A subframe relays through the background worker,
  // because an overlay rendered inside a small iframe would be clipped away.

  function ui(payload) {
    if (isTopFrame) render(payload);
    else send({ type: 'ui', payload });
  }

  function onMessage(msg) {
    if (msg?.type === 'ui' && isTopFrame) render(msg.payload);
  }

  function render(p) {
    if (!p) return;
    try {
      paint(p);
    } catch {
      // Documents that are not HTML (a raw .svg or .xml file) reject
      // attachShadow. The chord itself still works; only the overlay is lost.
    }
  }

  function paint(p) {
    // A pending flash-hide must not take down whatever we are about to draw
    // (a subframe's chord can land while the top frame's flash is still up).
    clearTimeout(flashTimer);
    switch (p.kind) {
      case 'cheatsheet':
        showCheatsheet();
        break;
      case 'picker':
        showPicker(p.tabs || [], p.index | 0);
        break;
      case 'header':
        showHeader('⌨ ' + comboLabel(config?.prefix) + ' …', PANEL_BG);
        break;
      case 'flash':
        flash('✓ ' + labelFor(p.actionId), OK_BG);
        break;
      case 'error':
        flash('✕ ' + (p.message || 'Action failed'), ERR_BG);
        break;
      case 'hide':
        hideIndicator();
        break;
    }
  }

  function prettify(id) {
    const s = String(id).replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function labelFor(actionId) {
    return labels[actionId] || prettify(actionId);
  }

  function ensureIndicator() {
    if (indicator && indicator.host.isConnected) return indicator;

    const host = document.createElement('div');
    // pointer-events:none — the panel sits over the page and must never
    // intercept a click meant for the content underneath it.
    host.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; bottom: 16px; right: 16px; pointer-events: none;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      '.pk-list{position:relative;width:440px;max-width:80vw;max-height:50vh;overflow-y:auto;margin:0 -6px}',
      '.pk-row{display:flex;gap:8px;align-items:baseline;padding:2px 6px;border-radius:5px;color:#d1d5db;white-space:nowrap}',
      '.pk-row.sel{background:#2563eb;color:#fff}',
      '.pk-n{flex:none;min-width:2.5ch;text-align:right;font-weight:700;color:#93c5fd}',
      '.pk-t{flex:1;overflow:hidden;text-overflow:ellipsis}',
      '.pk-h{flex:none;max-width:35%;overflow:hidden;text-overflow:ellipsis;color:#9ca3af}',
      '.pk-row.sel .pk-n,.pk-row.sel .pk-h{color:#dbeafe}',
      '.pk-hint{margin-top:6px;color:#9ca3af;font-size:11px;white-space:nowrap}',
    ].join('');
    root.appendChild(style);
    const panel = document.createElement('div');
    panel.style.cssText = [
      'font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      'color: #e5e7eb',
      'background: ' + PANEL_BG,
      'border: 1px solid rgba(255,255,255,.15)',
      'border-radius: 10px',
      'box-shadow: 0 8px 28px rgba(0,0,0,.45)',
      'padding: 10px 12px',
      'max-width: 480px',
      'max-height: 60vh',
      'overflow: hidden',
    ].join(';');
    const header = document.createElement('div');
    header.style.cssText = 'font-weight: 700; color: #fff; white-space: nowrap;';
    const body = document.createElement('div');
    panel.append(header, body);
    root.appendChild(panel);
    document.documentElement.appendChild(host);

    indicator = { host, panel, header, body };
    return indicator;
  }

  function showHeader(text, bg) {
    const { host, panel, header, body } = ensureIndicator();
    panel.style.background = bg;
    header.textContent = text;
    header.style.marginBottom = '0';
    body.replaceChildren();
    host.style.display = 'block';
  }

  // Full cheatsheet: the prefix plus a two-column list of key -> action.
  function showCheatsheet() {
    const { host, panel, header, body } = ensureIndicator();
    panel.style.background = PANEL_BG;
    header.textContent = '⌨ ' + comboLabel(config?.prefix);
    header.style.marginBottom = '8px';
    body.replaceChildren();

    const entries = Object.entries(config?.bindings || {}).sort((a, b) =>
      labelFor(a[1]).localeCompare(labelFor(b[1])),
    );
    if (entries.length === 0) {
      body.textContent = '(no shortcuts bound)';
    } else {
      const grid = document.createElement('div');
      grid.style.cssText =
        'display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 3px 10px; align-items: baseline;';
      for (const [combo, actionId] of entries) {
        const k = document.createElement('span');
        k.textContent = comboLabel(combo);
        k.style.cssText = 'font-weight: 700; color: #93c5fd; text-align: right;';
        const l = document.createElement('span');
        l.textContent = labelFor(actionId);
        l.style.cssText = 'color: #d1d5db; white-space: nowrap;';
        grid.append(k, l);
      }
      body.appendChild(grid);
    }
    host.style.display = 'block';
  }

  // Tab picker: one row per tab, the highlighted one kept in view. Rows are
  // rebuilt only when the set of tabs changes, so moving the highlight doesn't
  // reset the list's scroll position.
  let pickerList = null; // { key, list, rows }

  function showPicker(tabs, index) {
    const { host, panel, header, body } = ensureIndicator();
    panel.style.background = PANEL_BG;
    header.textContent = '⌨ ' + labelFor(PICKER_ACTION);
    header.style.marginBottom = '6px';

    const key = tabs.map((t) => t.id).join(',');
    if (!pickerList || pickerList.key !== key || pickerList.list.parentNode !== body) {
      const list = document.createElement('div');
      list.className = 'pk-list';
      const rows = tabs.map((t, i) => {
        const row = document.createElement('div');
        row.className = 'pk-row';
        const n = document.createElement('span');
        n.className = 'pk-n';
        n.textContent = i + 1 + (t.active ? '*' : ''); // "3*": current, as in tmux
        const title = document.createElement('span');
        title.className = 'pk-t';
        title.textContent = (t.pinned ? '📌 ' : '') + (t.title || '(untitled)');
        const h = document.createElement('span');
        h.className = 'pk-h';
        h.textContent = t.host || '';
        row.append(n, title, h);
        list.appendChild(row);
        return row;
      });
      const hint = document.createElement('div');
      hint.className = 'pk-hint';
      hint.textContent = 'Ctrl+N / ↓ down · Ctrl+P / ↑ up · ↵ switch · Esc cancel';
      body.replaceChildren(list, hint);
      pickerList = { key, list, rows };
    }

    const { list, rows } = pickerList;
    rows.forEach((row, i) => row.classList.toggle('sel', i === index));
    host.style.display = 'block';

    // Scroll the list itself, never the page underneath.
    const row = rows[index];
    if (row) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight;
      }
    }
  }

  function flash(text, bg) {
    showHeader(text, bg);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (!prefixActive) hideIndicator();
    }, FLASH_MS);
  }

  function hideIndicator() {
    if (indicator) indicator.host.style.display = 'none';
  }

  // --- lifecycle -------------------------------------------------------------
  function teardown() {
    clearTimeout(prefixTimer);
    clearTimeout(flashTimer);
    prefixActive = false;
    picker = null;
    pickerList = null;
    swallowed.clear();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('focus', wake, true);
    window.removeEventListener('pointerdown', wake, true);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* context already gone */
    }
    indicator?.host.remove();
    indicator = null;
    if (globalThis.__shortcutsTeardown === teardown) delete globalThis.__shortcutsTeardown;
  }

  globalThis.__shortcutsTeardown = teardown;

  window.addEventListener('keydown', onKeyDown, true); // capture phase
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerdown', onPointerDown, true);

  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
    if (isTopFrame) chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    /* context already gone */
  }

  if (isTopFrame || document.hasFocus()) {
    loadConfig();
  } else {
    window.addEventListener('focus', wake, true);
    window.addEventListener('pointerdown', wake, true);
  }
})();
