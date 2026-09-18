import type { TranslationResult } from "./messages";
import { sessionGet, sessionSet } from "./session-store";

// LRU cache of finished translations. Kept in memory for speed and mirrored to
// chrome.storage.session so it outlives service-worker restarts (which happen
// after ~30s of inactivity — i.e. between almost every two lookups).
const STORAGE_KEY = "translateCache";
const MAX_ENTRIES = 300;

type Entry = [key: string, value: TranslationResult];

const mem = new Map<string, TranslationResult>();
let hydrated: Promise<void> | null = null;

function hydrate(): Promise<void> {
  if (!hydrated) {
    hydrated = sessionGet<Entry[]>(STORAGE_KEY).then((entries) => {
      if (!Array.isArray(entries)) return;
      for (const [k, v] of entries) if (!mem.has(k)) mem.set(k, v);
    });
  }
  return hydrated;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  // Coalesce bursts of writes into one storage call.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void sessionSet(STORAGE_KEY, [...mem.entries()]);
  }, 50);
}

export async function cacheGet(key: string): Promise<TranslationResult | undefined> {
  await hydrate();
  const v = mem.get(key);
  if (v !== undefined) {
    // Refresh recency.
    mem.delete(key);
    mem.set(key, v);
  }
  return v;
}

export async function cacheSet(key: string, value: TranslationResult): Promise<void> {
  await hydrate();
  mem.delete(key);
  mem.set(key, value);
  while (mem.size > MAX_ENTRIES) {
    mem.delete(mem.keys().next().value as string);
  }
  schedulePersist();
}
