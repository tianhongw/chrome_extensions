import { createEnhancer } from '../core/enhance.js';
import { LIB_FILES } from '../core/libs.js';
import { createMarkdown } from '../core/markdown.js';
import { applyColorSchemeToSources, onCopyClick, renderDocument } from '../core/render.js';
import { THEME_MODES, createTheme } from '../core/theme.js';
import { debounce } from '../shared/dom.js';
import { localize, t } from '../shared/i18n.js';
import { icons } from '../shared/icons.js';
import { MARKDOWN_KEYS, WIDTHS, loadSettings, onSettingsChanged, saveSettings } from '../shared/settings.js';

// Standalone editor with live preview: type or paste Markdown, open or drop a
// file, and save it back to disk (File System Access API) with Cmd/Ctrl+S.

const DRAFT_KEY = 'editorDraft';
const VIEW_KEY = 'mdp-editor-view';
const WATCH_INTERVAL = 1000;
const FILE_TYPES = [
  {
    description: 'Markdown',
    accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'], 'text/plain': ['.txt'] },
  },
];

const $ = (id) => document.getElementById(id);
const source = $('source');
const preview = $('preview');
const previewPane = $('preview-pane');
const workspace = $('workspace');

const state = {
  settings: null,
  md: null,
  handle: null, // FileSystemFileHandle of the open file, when there is one
  name: '',
  opened: false, // content came from (or was saved to) a file
  savedText: '',
  lastModified: 0,
};

const scripts = new Map();

function loadLib(name) {
  if (!scripts.has(name)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = LIB_FILES[name];
      script.onload = () => resolve(globalThis[name]);
      script.onerror = () => {
        scripts.delete(name);
        reject(new Error(`Failed to load ${name}`));
      };
      document.head.append(script);
    });
    scripts.set(name, promise);
  }
  return scripts.get(name);
}

const enhancer = createEnhancer(loadLib);
const theme = createTheme((scheme) => {
  applyColorSchemeToSources(preview, scheme);
  enhancer.run(preview, scheme);
});

function render() {
  const { fragment } = renderDocument(state.md, source.value);
  preview.replaceChildren(fragment);
  applyColorSchemeToSources(preview, theme.scheme);
  enhancer.run(preview, theme.scheme);
}

const scheduleRender = debounce(render, 120);

const persistDraft = debounce(() => {
  chrome.storage.local.set({ [DRAFT_KEY]: { text: source.value, name: state.name } });
}, 400);

const isDirty = () => source.value !== state.savedText;

function updateTitle() {
  const unsaved = state.opened && isDirty();
  $('file-name').textContent = state.name;
  $('file-name').title = state.name;
  $('file-state').hidden = !unsaved;
  document.title = `${unsaved ? '● ' : ''}${state.name} · ${t('editorTitle')}`;
}

function setDocument({ text, name, handle = null, lastModified = 0, opened = false }) {
  Object.assign(state, { handle, name, lastModified, opened, savedText: opened ? text : '' });
  source.value = text;
  source.scrollTop = 0;
  previewPane.scrollTop = 0;
  render();
  updateTitle();
}

// Asks before replacing content that would otherwise be lost.
function confirmDiscard() {
  const hasChanges = state.opened ? isDirty() : source.value.trim() !== '';
  return !hasChanges || confirm(t('editorConfirmDiscard'));
}

function newDocument() {
  if (!confirmDiscard()) return;
  setDocument({ text: '', name: t('editorUntitled') });
  persistDraft();
  source.focus();
}

async function openFile() {
  if (!('showOpenFilePicker' in window)) {
    $('file-input').click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({ types: FILE_TYPES });
    await openHandle(handle);
  } catch (err) {
    if (err.name !== 'AbortError') showToast(err.message);
  }
}

async function openHandle(handle) {
  const file = await handle.getFile();
  if (!confirmDiscard()) return;
  setDocument({ text: await file.text(), name: file.name, handle, lastModified: file.lastModified, opened: true });
}

async function openFileObject(file) {
  if (!confirmDiscard()) return;
  setDocument({ text: await file.text(), name: file.name, opened: true });
}

function suggestedName() {
  return /\.(?:md|markdown|mdown|mkdn?|txt)$/i.test(state.name) ? state.name : `${state.name || 'untitled'}.md`;
}

async function saveFile() {
  const text = source.value;
  try {
    if (!state.handle && 'showSaveFilePicker' in window) {
      state.handle = await window.showSaveFilePicker({ suggestedName: suggestedName(), types: FILE_TYPES });
      state.name = state.handle.name;
    }
    if (state.handle) {
      const writable = await state.handle.createWritable();
      await writable.write(text);
      await writable.close();
      state.lastModified = (await state.handle.getFile()).lastModified;
    } else {
      download(text, suggestedName());
    }
    Object.assign(state, { opened: true, savedText: text });
    updateTitle();
    persistDraft();
    showToast(t('editorSaved'));
  } catch (err) {
    if (err.name !== 'AbortError') showToast(err.message);
  }
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Reload the open file when it changes on disk, unless there are unsaved edits.
async function checkOpenFile() {
  if (!state.handle || document.visibilityState !== 'visible') return;
  let file;
  try {
    file = await state.handle.getFile();
  } catch {
    return; // moved, deleted or permission revoked
  }
  if (file.lastModified === state.lastModified) return;
  state.lastModified = file.lastModified;
  if (isDirty()) return;
  const text = await file.text();
  if (text === source.value) return;
  const { selectionStart, selectionEnd, scrollTop } = source;
  source.value = text;
  state.savedText = text;
  source.setSelectionRange(selectionStart, selectionEnd);
  source.scrollTop = scrollTop;
  render();
  updateTitle();
  showToast(t('editorReloaded'));
}

let toastTimer;
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

function setView(view) {
  workspace.dataset.view = ['edit', 'split', 'preview'].includes(view) ? view : 'split';
  for (const input of document.querySelectorAll('input[name="view"]')) {
    input.checked = input.value === workspace.dataset.view;
  }
  try {
    localStorage.setItem(VIEW_KEY, workspace.dataset.view);
  } catch {
    // storage unavailable; the view just won't be remembered
  }
}

function updateThemeButton() {
  const button = $('theme');
  const label = t('actionTheme', t(`theme_${theme.mode}`));
  button.innerHTML = icons[theme.mode];
  button.title = label;
  button.setAttribute('aria-label', label);
}

function applySettings(changedKeys) {
  const { settings } = state;
  const root = document.documentElement;
  root.style.setProperty('--mdp-width', WIDTHS[settings.width] ?? WIDTHS.normal);
  root.style.setProperty('--mdp-font-size', `${Math.min(24, Math.max(12, Number(settings.fontSize) || 16))}px`);
  $('custom-css').textContent = settings.customCss || '';
  theme.setMode(settings.theme);
  updateThemeButton();
  if (!changedKeys || changedKeys.some((key) => MARKDOWN_KEYS.includes(key))) {
    state.md = createMarkdown(settings);
    if (changedKeys) render();
  }
}

async function initialDocument() {
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    const locale = chrome.i18n.getUILanguage().toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
    const response = await fetch(`demo/${locale}.md`);
    return { text: await response.text(), name: 'demo.md' };
  }
  if (params.get('import') === 'selection') {
    const { editorImport = '' } = await chrome.storage.session.get('editorImport');
    await chrome.storage.session.remove('editorImport');
    return { text: editorImport, name: t('editorUntitled') };
  }
  const { [DRAFT_KEY]: draft } = await chrome.storage.local.get(DRAFT_KEY);
  return { text: draft?.text ?? '', name: draft?.name || t('editorUntitled') };
}

function bindEvents() {
  source.addEventListener('input', () => {
    scheduleRender();
    updateTitle();
    persistDraft();
  });
  source.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      document.execCommand('insertText', false, '  '); // keeps the native undo stack
    } else if (event.key === 'Escape') {
      source.blur();
    }
  });
  source.addEventListener(
    'scroll',
    () => {
      if (workspace.dataset.view !== 'split') return;
      const ratio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
      previewPane.scrollTop = ratio * (previewPane.scrollHeight - previewPane.clientHeight);
    },
    { passive: true },
  );

  preview.addEventListener('click', (event) => {
    onCopyClick(event);
    // External links open in a new tab instead of navigating the editor away.
    const link = event.target.closest('a[href]');
    if (link && !link.getAttribute('href').startsWith('#')) {
      event.preventDefault();
      window.open(link.href, '_blank', 'noopener');
    }
  });

  $('new').addEventListener('click', newDocument);
  $('open').addEventListener('click', openFile);
  $('save').addEventListener('click', saveFile);
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('theme').addEventListener('click', () => {
    const next = THEME_MODES[(THEME_MODES.indexOf(theme.mode) + 1) % THEME_MODES.length];
    theme.setMode(next);
    updateThemeButton();
    saveSettings({ theme: next });
  });
  for (const input of document.querySelectorAll('input[name="view"]')) {
    input.addEventListener('change', () => setView(input.value));
  }
  $('file-input').addEventListener('change', (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) openFileObject(file);
  });

  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      saveFile();
    } else if (key === 'o') {
      event.preventDefault();
      openFile();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (state.opened && isDirty()) event.preventDefault();
  });

  // Drag & drop a file anywhere on the page to open it.
  const dropZone = $('drop-zone');
  const hasFiles = (event) => event.dataTransfer?.types.includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth++;
    dropZone.hidden = false;
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event) || --dragDepth > 0) return;
    dragDepth = 0;
    dropZone.hidden = true;
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropZone.hidden = true;
    const item = [...event.dataTransfer.items].find((entry) => entry.kind === 'file');
    if (!item) return;
    // Both must be requested synchronously, while the dropped data is accessible.
    const handlePromise = item.getAsFileSystemHandle?.();
    const file = item.getAsFile();
    (async () => {
      const handle = await handlePromise?.catch(() => null);
      if (handle?.kind === 'file') await openHandle(handle);
      else if (file) await openFileObject(file);
    })().catch((err) => showToast(err.message));
  });

  setInterval(checkOpenFile, WATCH_INTERVAL);
}

async function main() {
  localize();
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icons[el.dataset.icon];
  state.settings = await loadSettings();
  applySettings();
  let view = 'split';
  try {
    view = localStorage.getItem(VIEW_KEY) ?? view;
  } catch {
    // use the default view
  }
  setView(view);
  bindEvents();
  setDocument(await initialDocument());
  onSettingsChanged((keys, settings) => {
    state.settings = settings;
    applySettings(keys);
  });
  if (!source.value) source.focus();
}

main();
