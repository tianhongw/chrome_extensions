// Per-document annotation persistence via chrome.storage.local.
// Strokes are vector data (small), debounced-saved, and restored by a stable
// docId derived from the PDF URL (or filename+size for drag-and-dropped files).

// cyrb53 — tiny, fast, non-crypto string hash → stable short id.
function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

export function makeDocId(seed) {
  return hashString(String(seed));
}

export class Store {
  constructor(docId) {
    this.key = "pdfdraw:" + docId;
    this._timer = null;
  }

  async load() {
    try {
      const obj = await chrome.storage.local.get(this.key);
      return obj[this.key] || null;
    } catch (e) {
      console.warn("[pdf-drawer] load failed:", e);
      return null;
    }
  }

  /** Debounced save. `data` = { pages: { [pageIndex]: stroke[] }, meta } */
  save(data, { immediate = false } = {}) {
    clearTimeout(this._timer);
    const write = () =>
      chrome.storage.local
        .set({ [this.key]: { v: 1, updated: Date.now(), ...data } })
        .catch((e) => console.warn("[pdf-drawer] save failed:", e));
    if (immediate) return write();
    this._timer = setTimeout(write, 800);
  }
}
