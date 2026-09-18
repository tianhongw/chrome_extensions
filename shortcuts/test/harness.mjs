// Shared fake-chrome harness for exercising the extension modules under node.
export function installChrome({ tabs = [], windows = [], lastFocused = 1, delay = 0 } = {}) {
  const areas = { session: {}, sync: {}, local: {} };
  const nap = () => new Promise((r) => setTimeout(r, delay));

  const mkArea = (name) => ({
    async get(key) {
      await nap();
      const store = areas[name];
      if (key == null) return structuredClone(store);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) {
      await nap();
      Object.assign(areas[name], structuredClone(obj));
    },
  });

  const state = { tabs, windows, lastFocused, calls: [] };
  const log = (...a) => state.calls.push(a.join(' '));

  globalThis.chrome = {
    storage: { session: mkArea('session'), sync: mkArea('sync'), local: mkArea('local') },
    tabs: {
      async query(q) {
        await nap();
        return structuredClone(
          state.tabs.filter(
            (t) =>
              (q.windowId === undefined || t.windowId === q.windowId) &&
              (q.active === undefined || t.active === q.active),
          ),
        );
      },
      async get(id) {
        await nap();
        const t = state.tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return structuredClone(t);
      },
      async update(id, props) {
        await nap();
        const t = state.tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        if (props.active) {
          for (const o of state.tabs) if (o.windowId === t.windowId) o.active = false;
          t.active = true;
          log('activate', id);
        }
        Object.assign(t, props);
      },
      async move(id, { index }) {
        await nap();
        const t = state.tabs.find((x) => x.id === id);
        const peers = state.tabs.filter((x) => x.windowId === t.windowId).sort((a, b) => a.index - b.index);
        const from = peers.indexOf(t);
        peers.splice(from, 1);
        peers.splice(index, 0, t);
        peers.forEach((x, i) => (x.index = i));
        // Chrome refuses to interleave pinned and unpinned tabs.
        const bad = peers.some((x, i) => x.pinned && peers.slice(0, i).some((y) => !y.pinned));
        if (bad) throw new Error('pinned/unpinned interleaved');
        log('move', id, '->', index);
      },
      async remove(id) { await nap(); log('remove', id); },
      async create(o) { await nap(); log('create', JSON.stringify(o)); },
      async duplicate(id) { await nap(); log('duplicate', id); },
      async reload(id) { await nap(); log('reload', id); },
    },
    windows: {
      async getLastFocused() { await nap(); return { id: state.lastFocused }; },
      async update(id, props) { await nap(); if (props.focused) log('focusWindow', id); },
    },
    sessions: { async restore() { await nap(); log('restore'); } },
    runtime: { id: 'test', getManifest: () => ({ content_scripts: [{ js: ['keys.js', 'content.js'] }] }) },
  };
  return { state, areas };
}
