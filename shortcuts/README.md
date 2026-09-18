# Shortcuts — tmux-style prefix keys for Chrome

Press a **prefix** key (default `Ctrl+A`), then a **shortcut** key, to control your
tabs — exactly like a tmux prefix. For example:

```
Ctrl+A  then  l   →  switch to last (previously focused) tab
```

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. The extension is active immediately, including in tabs that were already
   open. Click its toolbar icon for a quick toggle, or **Customize…** to open
   the full settings page.

> Reload the extension from `chrome://extensions` after editing the source.

## Default shortcuts

After pressing the prefix (`Ctrl+A`):

| Key | Action                |
| --- | --------------------- |
| `l` | Switch to last tab    |
| `n` | Next tab              |
| `p` | Previous tab          |
| `g` | First tab             |
| `e` | Last tab (rightmost)  |
| `w` | Choose tab (picker)   |
| `c` | New tab               |
| `x` | Close tab             |
| `u` | Reopen closed tab     |
| `d` | Duplicate tab         |
| `r` | Reload tab            |
| `m` | Toggle mute           |
| `i` | Toggle pin            |
| `,` | Move tab left         |
| `.` | Move tab right        |

You may keep the prefix's modifier held down for the second key — `Ctrl+A` then
`Ctrl+L` works the same as releasing Ctrl first, like tmux.

### The tab picker

`Ctrl+A` then `w` lists the tabs of the current window, like tmux's `prefix w`:

```
⌨ Choose tab
  1   Inbox                          mail.google.com
  2*  Shortcuts — tmux-style …       github.com
  3   📌 Calendar                    calendar.google.com
Ctrl+N / ↓ down · Ctrl+P / ↑ up · ↵ switch · Esc cancel
```

`*` marks the current tab. `Ctrl+N` / `Ctrl+P` (or `↓` / `↑`) move the
highlight, `Enter` switches to the highlighted tab, and `Esc` (or `q`) cancels.
The picker is modal: while it is open, nothing you type reaches the page, and it
closes by itself if you click or the window loses focus.

> On Windows and Linux, Chrome reserves `Ctrl+N` for "new window" and a page
> never sees it, so use `↓` / `↑` there. On macOS, `Ctrl+N` / `Ctrl+P` work as
> expected.

`Esc` (or waiting out the timeout, 3s by default) cancels prefix mode. A badge
appears in the bottom-right corner while waiting for the second key, and flashes
green — or red, with the reason — once the action has run.

Everything — the prefix, every binding, the timeout, and whether to ignore the
prefix while typing in text fields — is editable on the options page.

## How it works

- **`keys.js`** is the single source of truth for parsing and formatting key
  combos. It is written to load both as a classic content script and as an ES
  module, so the content script and the extension pages cannot drift apart.
- **`content.js`** runs on every page *and every frame*, captures the prefix at
  the capture phase, enters "prefix mode", then maps the next key to an action
  id. Only the top frame draws the on-screen badge; a subframe relays through
  the background worker so its overlay isn't clipped inside a small iframe.
- **`background.js`** (service worker) performs the tab operations via the
  `chrome.tabs` API and tracks per-window tab-activation history so *last tab*
  works. The tab picker is the one action that runs in the page: the worker
  only returns the tab list, and the choice comes back as an `activate-tab`
  message. History lives in `chrome.storage.session` so it survives the service
  worker being suspended, and every read/write is serialised through one promise
  chain — `onActivated` fires faster than a storage round-trip completes.
- **`actions.js`** is the shared registry of actions, defaults, and config
  migration, imported by the background worker and the popup/options pages.
- Config lives in `chrome.storage.sync`, so it follows your Chrome profile.

## Known limitations

- Content scripts cannot run on `chrome://` pages, the New Tab page, the Chrome
  Web Store, `view-source:`, or other restricted URLs — shortcuts won't fire
  while one of those pages is focused. (Switch focus to a normal page first.)
- The prefix is captured globally by default, which overrides the page's own
  `Ctrl+A` (select-all). Enable **Ignore while typing** on the options page to
  keep native select-all inside text fields.
- Chrome reserves a handful of chords (`Ctrl+W`, `Ctrl+N`, `Ctrl+T`, …) that a
  web page cannot intercept, so they can't be used as a prefix. On Windows and
  Linux this also means the picker's `Ctrl+N` never arrives — use `↓` there.
- "Last tab" needs at least one tab switch after Chrome starts before it has a
  previous tab to return to.

## Tests

Pure logic — key parsing, config migration, the history serialisation, and the
tab actions against a stubbed `chrome` API. No dependencies:

```sh
node test/run.mjs
```

## Adding a new action

Add an entry to `ACTIONS` in `actions.js`:

```js
'close-others': {
  label: 'Close other tabs',
  description: 'Close every tab except the current one.',
  defaultKey: 'o',
  async run(ctx) {
    const t = await currentTab(ctx);
    const others = await chrome.tabs.query({ windowId: t.windowId, active: false });
    await chrome.tabs.remove(others.map((x) => x.id));
  },
},
```

Reload the extension and the new action appears on the options page
automatically. Because its id isn't in the saved config's `knownActions` list,
it also picks up its `defaultKey` on upgrade — without resurrecting bindings you
deliberately cleared.
