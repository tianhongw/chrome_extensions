import bubbleCss from "../content/bubble.css?inline";
import resultCss from "./result.css?inline";
import { renderResult, showError, showLoading, showPartial } from "../lib/render";
import type { ResultPayload } from "../lib/messages";

const style = document.createElement("style");
style.textContent = bubbleCss + "\n" + resultCss;
document.head.appendChild(style);

const app = document.getElementById("app")!;
const card = document.createElement("div");
card.className = "yd-bubble";
app.appendChild(card);

function render(payload: ResultPayload | undefined | null): void {
  if (!payload) {
    showError(card, "没有结果");
    return;
  }
  if ("loading" in payload) {
    if (payload.partial) showPartial(card, payload.partial);
    else showLoading(card, `翻译中… ${payload.query}`);
    return;
  }
  if ("error" in payload) {
    showError(card, `翻译失败：${payload.error}`);
    return;
  }
  renderResult(card, payload.data);
}

async function init(): Promise<void> {
  const { lastResult } = await chrome.storage.session.get("lastResult");
  render(lastResult as ResultPayload | undefined);
}

// Live-update when the background pushes a new translation into the same window.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.lastResult) render(changes.lastResult.newValue as ResultPayload | undefined);
});

void init();
