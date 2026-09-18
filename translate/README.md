# Selection Translate (Youdao)

A minimal Chrome extension: **select any text** on a web page, click the floating "译" button, and the translation appears in a popup bubble. Powered by the free [Youdao web translation](https://fanyi.youdao.com/), with automatic Chinese ↔ English direction detection — no API key required.

## Features

- **Selection translation** — select text (mouse, or Shift+arrows) → click "译" → see the result in a bubble
- **Streaming output** — long texts render progressively as Youdao's LLM generates them
- **Dictionary cards** for single words / short phrases: phonetics, exam tags, definitions by part of speech, word forms, phrases
- **Automatic direction detection** between Chinese and English
- **One-click copy** of the translated text
- **Fast repeats** — results are cached in session storage (survives service-worker restarts), and the Youdao signing key is reused across requests instead of being re-fetched every time
- **Stays on screen** — the bubble is clamped inside the viewport and opens above the selection when there is no room below
- **Context-menu translation** (works inside Chrome's PDF viewer) shown in a small result window
- **Light/dark mode aware**; styles isolated via Shadow DOM so the host page is never affected

## Build

Requires Node.js 18+.

```bash
npm install
npm run build      # output goes to dist/
# or development mode (HMR):
npm run dev
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this project's `dist/` directory
4. Open any web page, select some text, and click the "译" button that appears

## How It Works

The current `fanyi.youdao.com` backend uses an "LLM + signature + SSE streaming" API, in two steps:

1. `POST https://dict-trans.youdao.com/translate/key` → returns a `token` and `secretKey`. The pair stays valid across many requests, so it is cached (memory + `storage.session`) and only re-fetched when the translate endpoint answers `{"code":403}` (signature rejected), in which case the request is retried once.
2. `POST https://dict-trans.youdao.com/webtranslate/sse` (multipart, signed with `secretKey`) → returns a `text/event-stream` that streams incremental chunks `{"transIncre":"…"}`. The body is parsed as it arrives and partial text is pushed to the content script over a `chrome.runtime.connect` port, so the bubble fills in progressively.

Single words and short phrases are additionally looked up on `dict.youdao.com/jsonapi` (in parallel with the machine translation) to build the dictionary card.

> Note: the older `dict.youdao.com/webtranslate` endpoint now returns poisoned/fake translations (a honeypot), so this extension does not use it.

### Architecture

- **Content script** (`src/content`) — watches the text selection, shows the trigger button and the bubble, and keeps them inside the viewport.
- **Background service worker** (`src/background`) — centralizes network requests (using `host_permissions` to bypass CORS), streams results to clients over ports, owns the cache and the context-menu / result-window flow.
- **Result window** (`src/result`) — standalone page for context-menu translations; live-updates from `storage.session`.
- **Lib** (`src/lib`):
  - `youdao.ts` — key caching, `sign` via `genSign` (sort parameters, concatenate, append `key=<secret>`, then MD5), incremental SSE parsing, dictionary lookup.
  - `cache.ts` — LRU translation cache mirrored to `storage.session`.
  - `session-store.ts` — small `chrome.storage.session` wrapper.
  - `render.ts` — DOM rendering shared by the bubble and the result window.
  - `md5.ts` — provides MD5 (the Web Crypto API does not support MD5).

## Notes

This extension relies on Youdao's **unofficial** web endpoints. The relevant constants are reverse-engineered from its frontend and may break when Youdao updates theirs. If translation starts failing, update the constants at the top of `src/lib/youdao.ts` (`KEY_GETTER_SECRET` / `KEY_GETTER_KEYID` / `TARGET_KEYID`, etc.).

For personal/educational use only.
