# Chrome Extensions

A monorepo of independent Chrome extensions (Manifest V3) built for personal use.

## Extensions

| Extension | Description |
| --- | --- |
| [mdpreview](./mdpreview) | Render Markdown files in the browser — GitHub style, outline, syntax highlighting, math (KaTeX), Mermaid diagrams, live reload. |
| [translate](./translate) | Select text on any page, click the floating "译" button, get a streaming Youdao translation bubble. Chinese ↔ English direction auto-detected, no API key. |
| [tabs_manage](./tabs_manage) | Compact tab manager: list by domain, search, close, pin, mute, deduplicate across windows. |
| [shortcuts](./shortcuts) | tmux-style prefix keys for Chrome: press `Ctrl+A` then a key to switch / close / pin / mute tabs, open a tab picker, and more. |
| [drawer](./drawer) | PDF handwriting annotation — draw on PDFs with pen/eraser, auto-save strokes per document, export to PDF/PNG. |

## Install

Each extension is loaded as an **unpacked** extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select the extension's `dist/` directory (for built projects: `mdpreview`, `translate`) or the extension's root directory (for zero-build projects: `tabs_manage`, `shortcuts`, `drawer`).

> For extensions that access local files (`mdpreview`, `drawer`), open the extension's **Details** page and enable **Allow access to file URLs**.

## Repository layout

```
chrome_extensions/
├── mdpreview/      Markdown renderer (build: npm run build → dist/)
├── translate/      Selection translate (build: npm run build → dist/)
├── tabs_manage/    Tab manager (no build step)
├── shortcuts/      tmux-style shortcuts (no build step)
└── drawer/         PDF handwriting (no build step)
```

Each subdirectory has its own README with detailed setup, usage, and architecture notes.
