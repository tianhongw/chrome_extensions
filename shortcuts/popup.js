import { ACTIONS, CONFIG_KEY, comboLabel, normalizeConfig } from './actions.js';

const els = {
  enabled: document.getElementById('enabled'),
  prefix: document.getElementById('prefix'),
  bindings: document.getElementById('bindings'),
  customize: document.getElementById('customize'),
};

async function getConfig() {
  const res = await chrome.storage.sync.get(CONFIG_KEY);
  return normalizeConfig(res[CONFIG_KEY]);
}

function render(config) {
  els.enabled.checked = !!config.enabled;
  els.prefix.textContent = comboLabel(config.prefix);
  document.body.classList.toggle('off', !config.enabled);

  const entries = Object.entries(config.bindings || {})
    .filter(([, id]) => ACTIONS[id])
    .sort((a, b) => ACTIONS[a[1]].label.localeCompare(ACTIONS[b[1]].label));

  els.bindings.replaceChildren();
  for (const [combo, actionId] of entries) {
    const li = document.createElement('li');
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = comboLabel(combo);
    const label = document.createElement('span');
    label.textContent = ACTIONS[actionId].label;
    li.append(key, label);
    els.bindings.appendChild(li);
  }
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No shortcuts bound yet.';
    els.bindings.appendChild(li);
  }
}

els.enabled.addEventListener('change', async () => {
  // Re-read first: the options page may have written a newer config since this
  // popup opened, and writing back a stale copy would silently undo it.
  const config = await getConfig();
  config.enabled = els.enabled.checked;
  await chrome.storage.sync.set({ [CONFIG_KEY]: config });
  render(config);
});

els.customize.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[CONFIG_KEY]) {
    render(normalizeConfig(changes[CONFIG_KEY].newValue));
  }
});

getConfig().then(render);
