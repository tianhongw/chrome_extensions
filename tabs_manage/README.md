# Tab Management

Tab Management is a lightweight Chrome extension for managing tabs that are already open. It keeps the popup compact while covering the everyday tab actions: search, switch, close, pin, mute, and clean up duplicates.

## Screenshot

<img src="assets/plugin-screenshot.png" alt="Tab Management popup showing tabs grouped by domain" width="430">

## Features

- List all open tabs grouped by tab domain.
- Refresh the tab list manually from the popup.
- Search tabs by title or URL; multiple words match in any order.
- Press `/` anywhere in the popup to focus the search box.
- Use Up/Down in the search box to move through matches and Enter to switch to the highlighted tab (or the first match).
- Close every tab in a domain group.
- Click a tab to focus its window and switch to it.
- Close individual tabs.
- Close all open tabs across all Chrome windows, with a click-again confirmation. While a search or window filter is active, the button closes only the tabs currently listed.
- Pin or unpin individual tabs.
- Mute or unmute individual tabs.
- Close duplicate tabs by normalized exact URL, keeping the active, pinned, or current-window tab when possible.
- Treat `chrome://newtab/` tabs as duplicates; exclude other Chrome internal pages and extension pages.
- Toggle between all windows and the current window when multiple Chrome windows are open; disable that control when only one window is open.
- Load favicons from Chrome's own favicon cache instead of the network, so discarded tabs still show their icon and opening the popup makes no requests.

## Install From GitHub

This extension is currently meant to be loaded as an unpacked Chrome extension.

1. Clone this repository:

   ```bash
   git clone https://github.com/tianhongw/tabs_management.git
   cd tabs_management
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the cloned repository folder.
6. Click the Tab Management icon in the Chrome toolbar.

## Files

- `manifest.json` declares the MV3 extension and the `tabs` and `favicon` permissions.
- `popup.html` defines the popup structure.
- `styles.css` handles the compact popup UI.
- `popup.js` reads and updates Chrome tabs with the `chrome.tabs` and `chrome.windows` APIs.
- `assets/` contains the README screenshot.
- `icons/` contains the extension icon source and generated PNG sizes.

## Roadmap

- Save and restore tab sessions.
