import type { PronounceEvent, PronounceRequest } from "../lib/messages";

let activePort: chrome.runtime.Port | null = null;

export function connectPronunciation(port: chrome.runtime.Port): void {
  if (port.name !== "pronounce") return;
  let closed = false;
  let requested = false;

  const send = (event: PronounceEvent): void => {
    if (closed) return;
    try {
      port.postMessage(event);
    } catch {
      // The originating tab may have closed while speech was starting.
    }
  };
  const finish = (event: PronounceEvent): void => {
    if (closed) return;
    send(event);
    closed = true;
    if (activePort === port) activePort = null;
    port.disconnect();
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    // An older tab finishing must never stop a newer tab's pronunciation.
    if (activePort === port) {
      activePort = null;
      chrome.tts.stop();
    }
  });

  port.onMessage.addListener((msg: PronounceRequest) => {
    if (closed || requested) return;
    requested = true;
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (msg?.type !== "pronounce" || !text || text.length > 5000) {
      finish({ type: "error", error: "请选择不超过 5000 字的文本" });
      return;
    }

    activePort = port;
    try {
      chrome.tts.speak(text, {
        lang: /\p{Script=Han}/u.test(text) ? "zh-CN" : "en-US",
        enqueue: false,
        requiredEventTypes: ["end"],
        onEvent: (event) => {
          if (event.type === "start") send({ type: "start" });
          else if (event.type === "error") {
            finish({ type: "error", error: event.errorMessage || "语音不可用，请检查系统语音设置" });
          } else if (["end", "interrupted", "cancelled"].includes(event.type)) {
            finish({ type: "done" });
          }
        },
      }, () => {
        const error = chrome.runtime.lastError;
        if (error) finish({ type: "error", error: error.message || "无法播放发音" });
      });
    } catch (error) {
      finish({ type: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
