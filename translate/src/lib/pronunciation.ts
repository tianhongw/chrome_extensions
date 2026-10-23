import type { PronounceEvent, PronounceRequest } from "./messages";

let stopActive: (() => void) | null = null;

export function stopPronunciation(): void {
  stopActive?.();
}

const SPEAKER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/>' +
  '<path class="yd-pronounce__wave1" d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
  '<path class="yd-pronounce__wave2" d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
  "</svg>";

/**
 * Speaker icon that reads `text` aloud. `lang` overrides the background's
 * language guess (e.g. "en-GB" for the 英 phonetic); `label` names what is read.
 */
export function makePronounceButton(
  text: string,
  { lang, label = "朗读" }: { lang?: PronounceRequest["lang"]; label?: string } = {},
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "yd-pronounce";
  button.innerHTML = SPEAKER_ICON;
  let stop: (() => void) | null = null;

  const update = (playing: boolean, error?: string): void => {
    button.title = error
      ? `发音失败：${error}，点击重试`
      : playing ? "停止发音" : label;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(playing));
    button.classList.toggle("yd-pronounce--playing", playing);
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
      const request: PronounceRequest = { type: "pronounce", text, lang };
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
