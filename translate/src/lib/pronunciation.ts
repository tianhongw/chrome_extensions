import type { PronounceEvent, PronounceRequest } from "./messages";

let stopActive: (() => void) | null = null;

export function stopPronunciation(): void {
  stopActive?.();
}

export function makePronounceButton(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "yd-pronounce";
  let stop: (() => void) | null = null;

  const update = (playing: boolean, error?: string): void => {
    button.textContent = error ? "重试" : playing ? "停止" : "发音";
    button.title = error
      ? `发音失败：${error}，点击重试`
      : playing ? "停止发音" : "朗读选中文本";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(playing));
    button.classList.toggle("yd-pronounce--error", !!error);
  };
  update(false);

  // Keep the selection intact when a pronunciation button is clicked.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    if (stop) {
      stop();
      return;
    }
    stopPronunciation();
    let port: chrome.runtime.Port | undefined;
    let settled = false;
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      if (stopActive === stop) stopActive = null;
      stop = null;
      update(false, error);
      try {
        port?.disconnect();
      } catch {
        /* The extension may have been reloaded. */
      }
    };

    stop = () => finish();
    stopActive = stop;
    update(true);
    try {
      if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
      port = chrome.runtime.connect({ name: "pronounce" });
      port.onMessage.addListener((event: PronounceEvent) => {
        if (settled) return;
        if (event.type === "error") finish(event.error);
        else if (event.type === "done") finish();
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        finish(error?.message || "与扩展后台的连接已断开");
      });
      const request: PronounceRequest = { type: "pronounce", text };
      port.postMessage(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish(/Extension context invalidated/i.test(message)
        ? "扩展已更新，请刷新页面后重试"
        : message);
    }
  });
  return button;
}
