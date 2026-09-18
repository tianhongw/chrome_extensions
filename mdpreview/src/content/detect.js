import { DEFAULTS } from '../shared/settings.js';

// Runs at document_start on every page, so it only does cheap checks. For a
// plain-text Markdown document it hides the raw text and asks the background
// worker to inject the viewer (viewer.js), which reveals the page again.

const MARKDOWN_TYPES = ['text/markdown', 'text/x-markdown'];
const MARKDOWN_PATH_RE = /\.(?:md|markdown|mdown|mkdn?|mdwn|mdtxt|mdtext|rmd)$/i;

function isMarkdownDocument() {
  const type = document.contentType;
  if (MARKDOWN_TYPES.includes(type)) return true;
  return type === 'text/plain' && MARKDOWN_PATH_RE.test(location.pathname);
}

async function requestViewer() {
  const { enabled, renderLocal, renderRemote } = DEFAULTS;
  const settings = await chrome.storage.sync.get({ enabled, renderLocal, renderRemote });
  const allowed = location.protocol === 'file:' ? settings.renderLocal : settings.renderRemote;
  if (!settings.enabled || !allowed) return false;
  const response = await chrome.runtime.sendMessage({ type: 'mdp:inject' });
  if (response?.error) throw new Error(response.error);
  return true;
}

if (isMarkdownDocument()) {
  const root = document.documentElement;
  root.style.setProperty('visibility', 'hidden');
  const reveal = () => root.style.removeProperty('visibility');
  const failsafe = setTimeout(reveal, 5000);
  requestViewer()
    .then((injected) => {
      clearTimeout(failsafe);
      if (!injected) reveal();
    })
    .catch((err) => {
      console.warn('[Markdown Preview]', err);
      clearTimeout(failsafe);
      reveal();
    });
}
