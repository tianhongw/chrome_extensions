import { createTheme } from '../core/theme.js';
import { localize } from '../shared/i18n.js';
import { icons } from '../shared/icons.js';
import { loadSettings, saveSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);

async function main() {
  localize();
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon];
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const settings = await loadSettings();
  const theme = createTheme();
  theme.setMode(settings.theme);

  const enabled = $('enabled');
  enabled.checked = settings.enabled;
  enabled.addEventListener('change', () => saveSettings({ enabled: enabled.checked }));

  for (const input of document.querySelectorAll('input[name="theme"]')) {
    input.checked = input.value === theme.mode;
    input.addEventListener('change', () => {
      theme.setMode(input.value);
      saveSettings({ theme: input.value });
    });
  }

  $('open-editor').addEventListener('click', () => openTab('editor.html'));
  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
    $('file-access').hidden = false;
    $('file-access-fix').addEventListener('click', () => openTab(`chrome://extensions/?id=${chrome.runtime.id}`));
  }

  // Offer "render this page" for plain-text pages the viewer didn't pick up
  // automatically, e.g. a README without extension or a .txt file.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = tab?.id != null && (await pageStatus(tab.id));
  if (status && !status.rendered && status.type.startsWith('text/') && !/html|xml/.test(status.type)) {
    const button = $('render-page');
    button.hidden = false;
    button.addEventListener('click', async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['viewer.js'] }).catch(() => {});
      window.close();
    });
  }
}

async function pageStatus(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ type: document.contentType, rendered: Boolean(globalThis.__mdpViewer) }),
    });
    return injection?.result ?? null;
  } catch {
    return null; // no access to this page (chrome://, the Web Store, file access off…)
  }
}

function openTab(url) {
  chrome.tabs.create({ url });
  window.close();
}

main();
