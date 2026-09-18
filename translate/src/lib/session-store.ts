// Thin wrapper over chrome.storage.session. The MV3 service worker is torn down
// after ~30s idle, taking module-level state with it; session storage survives
// until the browser closes, so it's the right home for the translation cache
// and the Youdao signing key. Falls back to no-ops where the API is missing
// (e.g. when a lib is exercised outside an extension context).

function area(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

export async function sessionGet<T>(key: string): Promise<T | undefined> {
  const a = area();
  if (!a) return undefined;
  try {
    const obj = await a.get(key);
    return obj[key] as T | undefined;
  } catch {
    return undefined;
  }
}

export async function sessionSet(key: string, value: unknown): Promise<void> {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [key]: value });
  } catch {
    /* quota / transient errors are non-fatal: we just lose persistence */
  }
}

export async function sessionRemove(key: string): Promise<void> {
  const a = area();
  if (!a) return;
  try {
    await a.remove(key);
  } catch {
    /* ignore */
  }
}
