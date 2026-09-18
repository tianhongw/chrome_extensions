// keys.js — the single source of truth for key-combo parsing and formatting.
//
// This file is deliberately written so it works in BOTH worlds:
//   * as a classic content script (listed before content.js in the manifest,
//     where ES-module `import` is unavailable), and
//   * as an ES module imported for its side effect by actions.js.
// That is why it assigns to `globalThis` instead of using `export`. Content
// scripts declared in the manifest share one isolated-world global scope and
// run in order, so content.js sees `ShortcutKeys` by the time it runs.

(() => {
  // Order matters: this is the canonical order modifiers appear in a combo.
  const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

  // Keys that never form a chord on their own.
  const MODIFIER_KEYS = new Set([
    'Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead',
  ]);

  // Keys whose `e.key` is unreadable or invisible when printed verbatim.
  const KEY_LABELS = {
    ' ': 'Space',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    Enter: '↵',
    Backspace: '⌫',
    Delete: 'Del',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
  };

  const isModifierKey = (k) => MODIFIER_KEYS.has(k);

  // Build a canonical combo string from a KeyboardEvent: "Ctrl+a", "Shift+g", "l".
  function comboFromEvent(e) {
    if (typeof e.key !== 'string' || e.key === '') return '';
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    let key = e.key;
    if (key.length === 1) key = key.toLowerCase();
    parts.push(key);
    return parts.join('+');
  }

  // Split a combo into { mods, key }. Parsed from the left against the known
  // modifier names so that "+" as the bound key ("Ctrl++") survives the trip —
  // a naive split('+') loses it.
  function parseCombo(combo) {
    const mods = [];
    let rest = String(combo ?? '');
    for (;;) {
      const m = MODIFIERS.find(
        (mod) => rest.startsWith(mod + '+') && rest.length > mod.length + 1,
      );
      if (!m) break;
      mods.push(m);
      rest = rest.slice(m.length + 1);
    }
    return { mods, key: rest };
  }

  // Pretty-print a combo for display: "Ctrl+a" -> "Ctrl + A".
  function comboLabel(combo) {
    if (!combo) return '';
    const { mods, key } = parseCombo(combo);
    const shown = KEY_LABELS[key] || (key.length === 1 ? key.toUpperCase() : key);
    return [...mods, shown].join(' + ');
  }

  // True when the combo is a bare printable character with no modifier — such a
  // prefix would swallow ordinary typing on every page.
  function isUnsafePrefix(combo) {
    const { mods, key } = parseCombo(combo);
    return mods.length === 0 && key.length === 1;
  }

  globalThis.ShortcutKeys = {
    MODIFIERS,
    isModifierKey,
    comboFromEvent,
    parseCombo,
    comboLabel,
    isUnsafePrefix,
  };
})();
