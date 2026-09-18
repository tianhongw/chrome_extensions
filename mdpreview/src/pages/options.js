import { createTheme } from '../core/theme.js';
import { debounce } from '../shared/dom.js';
import { localize, t } from '../shared/i18n.js';
import { loadSettings, onSettingsChanged, resetSettings, saveSettings } from '../shared/settings.js';

// Every control carries data-setting="<key>" and is bound generically;
// data-requires="<key>" disables it while that boolean setting is off.

const $ = (id) => document.getElementById(id);
const controls = [...document.querySelectorAll('[data-setting]')];
const theme = createTheme();
let settings;

function readControl(el, event) {
  if (el.type === 'checkbox') return el.checked;
  if (el.classList.contains('segmented')) return event.target.value;
  if (el.dataset.type === 'number') return Number(el.value);
  return el.value;
}

function writeControl(el, value) {
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else if (el.classList.contains('segmented')) {
    for (const input of el.querySelectorAll('input')) input.checked = input.value === value;
  } else if (el !== document.activeElement) el.value = String(value);
}

function refresh() {
  for (const el of controls) writeControl(el, settings[el.dataset.setting]);
  $('font-size-value').textContent = `${settings.fontSize}px`;
  for (const el of document.querySelectorAll('[data-requires]')) {
    const off = !settings[el.dataset.requires];
    el.disabled = off;
    el.closest('.row')?.classList.toggle('disabled', off);
  }
  theme.setMode(settings.theme);
}

let toastTimer;
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
}

function bind(el) {
  const key = el.dataset.setting;
  const save = async (event) => {
    settings = { ...settings, [key]: readControl(el, event) };
    refresh();
    await saveSettings({ [key]: settings[key] });
    showToast(t('saved'));
  };
  if (el.tagName === 'TEXTAREA') el.addEventListener('input', debounce(save, 400));
  else el.addEventListener('change', save);
  if (el.type === 'range') {
    el.addEventListener('input', () => {
      $('font-size-value').textContent = `${el.value}px`;
    });
  }
}

async function checkFileAccess() {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  $('file-access').hidden = allowed;
}

async function main() {
  localize();
  document.title = `${t('extName')} · ${t('optionsSubtitle')}`;
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  settings = await loadSettings();
  refresh();
  controls.forEach(bind);
  onSettingsChanged((keys, next) => {
    settings = next;
    refresh();
  });

  checkFileAccess();
  $('file-access-fix').addEventListener('click', () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
  $('reset').addEventListener('click', async () => {
    if (!confirm(t('resetConfirm'))) return;
    await resetSettings();
    settings = await loadSettings();
    refresh();
    showToast(t('saved'));
  });
}

main();
