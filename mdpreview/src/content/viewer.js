import { createEnhancer } from '../core/enhance.js';
import { highlight } from '../core/highlight.js';
import { createMarkdown } from '../core/markdown.js';
import { applyColorSchemeToSources, onCopyClick, renderDocument } from '../core/render.js';
import { THEME_MODES, createTheme } from '../core/theme.js';
import { buildTocItems, collectHeadings, currentHeadingIndex } from '../core/toc.js';
import { h, whenDomReady } from '../shared/dom.js';
import { t } from '../shared/i18n.js';
import { icons } from '../shared/icons.js';
import { MARKDOWN_KEYS, WIDTHS, loadSettings, onSettingsChanged, saveSettings } from '../shared/settings.js';
import highlightCss from '../styles/highlight.css';
import markdownCss from '../styles/markdown.css';
import tokensCss from '../styles/tokens.css';
import viewerCss from '../styles/viewer.css';

// Replaces a plain-text Markdown document with the rendered viewer. Injected
// on demand by the background worker (see detect.js), the context menu or the
// popup, so it must tolerate being injected more than once.

const NARROW_QUERY = '(max-width: 1080px)';
const ACTIVE_HEADING_OFFSET = 80;
const MAX_HIGHLIGHTED_SOURCE = 500_000;
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const WORD_RE = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;

if (!globalThis.__mdpViewer) {
  globalThis.__mdpViewer = true;
  main()
    .catch((err) => console.error('[Markdown Preview]', err))
    .finally(() => document.documentElement.style.removeProperty('visibility'));
}

async function main() {
  await whenDomReady();
  const type = document.contentType;
  if (!type.startsWith('text/') || /html|xml/.test(type)) return;
  const pre = document.body?.querySelector(':scope > pre');
  const source = normalizeNewlines(pre ? pre.textContent : (document.body?.innerText ?? ''));
  const viewer = new Viewer(source, await loadSettings());
  viewer.mount();
  onSettingsChanged((keys, settings) => viewer.updateSettings(keys, settings));
}

class Viewer {
  constructor(source, settings) {
    this.source = source;
    this.settings = settings;
    this.md = createMarkdown(settings);
    this.enhancer = createEnhancer(loadLib);
    this.theme = createTheme((scheme) => this.onColorSchemeChange(scheme));
    this.narrow = matchMedia(NARROW_QUERY);
    this.filename = fileName();
    this.tocItems = [];
    this.activeIndex = -1;
    this.showingSource = false;
    this.fileHash = null;
    this.checking = false;
    this.watchGeneration = 0;
    this.watchFailures = 0;
  }

  mount() {
    history.scrollRestoration = 'manual';
    document.documentElement.classList.add('mdp');
    this.customStyle = h('style');
    (document.head ?? document.documentElement).append(
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('link', { rel: 'icon', href: chrome.runtime.getURL('icons/icon32.png') }),
      h('style', {}, tokensCss, markdownCss, highlightCss, viewerCss),
      this.customStyle,
    );

    this.article = h('article', { class: 'markdown-body', onclick: onCopyClick });
    this.sourceView = h('pre', { class: 'mdp-source', hidden: true });
    this.toc = h('nav', { class: 'mdp-toc', 'aria-label': t('tocTitle'), onclick: (e) => this.onTocClick(e) });
    this.stats = h('div', { class: 'mdp-stats' });
    const sidebar = h(
      'aside',
      { class: 'mdp-sidebar' },
      h(
        'div',
        { class: 'mdp-sidebar-header', title: safeDecodeURI(location.href) },
        h('span', { class: 'mdp-sidebar-icon', html: icons.file }),
        h('span', { class: 'mdp-filename' }, this.filename),
      ),
      this.toc,
      this.stats,
    );
    this.buttons = {
      toc: this.button('toc', t('actionToggleToc'), () => this.toggleToc()),
      theme: this.button('auto', '', () => this.cycleTheme()),
      source: this.button('code', t('actionViewSource'), () => this.toggleSource()),
      print: this.button('print', t('actionPrint'), () => window.print()),
      settings: this.button('settings', t('actionSettings'), () =>
        chrome.runtime.sendMessage({ type: 'mdp:open-options' }).catch(() => {}),
      ),
    };
    this.topButton = this.button('arrowUp', t('actionTop'), () => window.scrollTo({ top: 0 }));
    this.topButton.classList.add('mdp-top');
    this.toast = h('div', { class: 'mdp-toast', role: 'status' });

    document.body.replaceChildren(
      sidebar,
      h('div', { class: 'mdp-scrim', onclick: () => this.setTocOpen(false) }),
      h('main', { class: 'mdp-main' }, this.article, this.sourceView),
      h('div', { class: 'mdp-toolbar', role: 'toolbar' }, Object.values(this.buttons)),
      this.topButton,
      this.toast,
    );

    this.applyAppearance();
    this.setTocOpen(this.settings.toc && !this.narrow.matches);
    this.restoreInitialScroll(this.render());
    this.bindEvents();
    this.startWatching();
  }

  button(iconName, label, onclick) {
    return h('button', { type: 'button', class: 'mdp-button', title: label, 'aria-label': label, html: icons[iconName], onclick });
  }

  bindEvents() {
    let frame = 0;
    window.addEventListener(
      'scroll',
      () => {
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          this.updateActiveHeading();
          this.topButton.classList.toggle('mdp-show', window.scrollY > 600);
        });
      },
      { passive: true },
    );
    this.narrow.addEventListener('change', () => this.setTocOpen(this.settings.toc && !this.narrow.matches));
    window.addEventListener('pagehide', () => storeScroll(window.scrollY));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.isWatching()) this.checkForChanges();
    });
  }

  // Renders the current source; resolves once math and diagrams are done.
  render() {
    const { fragment, title } = renderDocument(this.md, this.source);
    this.article.replaceChildren(fragment);
    document.title = title || this.filename;
    applyColorSchemeToSources(this.article, this.theme.scheme);
    this.buildToc();
    this.updateStats();
    if (this.showingSource) this.renderSource();
    return this.enhance();
  }

  async enhance() {
    await this.enhancer.run(this.article, this.theme.scheme);
    this.updateActiveHeading();
  }

  // Re-render in place (file changed or parser settings changed), keeping the
  // reading position.
  async rerender() {
    const y = window.scrollY;
    const reader = watchReaderScroll();
    const done = this.render();
    window.scrollTo({ top: y, behavior: 'instant' });
    await done;
    if (!reader.scrolled) window.scrollTo({ top: y, behavior: 'instant' });
    reader.stop();
  }

  // Jump to the URL fragment, or to where the reader was before a reload.
  // Diagrams and math change the layout once rendered, so the jump is repeated
  // then, unless the reader has started scrolling in the meantime.
  async restoreInitialScroll(rendered) {
    const fragment = location.hash.slice(1);
    const saved = fragment ? 0 : takeStoredScroll();
    if (!fragment && saved <= 0) return;
    const apply = () => {
      if (fragment) scrollToFragment(fragment);
      else window.scrollTo({ top: saved, behavior: 'instant' });
    };
    const reader = watchReaderScroll();
    apply();
    await rendered;
    if (!reader.scrolled) apply();
    reader.stop();
  }

  applyAppearance() {
    const { settings } = this;
    const root = document.documentElement;
    root.style.setProperty('--mdp-width', WIDTHS[settings.width] ?? WIDTHS.normal);
    root.style.setProperty('--mdp-font-size', `${clamp(Number(settings.fontSize) || 16, 12, 24)}px`);
    this.customStyle.textContent = settings.customCss || '';
    this.theme.setMode(settings.theme);
    this.updateThemeButton();
  }

  updateSettings(keys, settings) {
    this.settings = settings;
    if (keys.some((key) => ['theme', 'width', 'fontSize', 'customCss'].includes(key))) this.applyAppearance();
    if (keys.includes('toc')) this.setTocOpen(settings.toc && !this.narrow.matches);
    if (keys.some((key) => MARKDOWN_KEYS.includes(key))) {
      this.md = createMarkdown(settings);
      this.rerender();
    }
    if (keys.includes('autoReload') || keys.includes('reloadInterval')) this.startWatching();
  }

  onColorSchemeChange(scheme) {
    if (!this.article) return;
    applyColorSchemeToSources(this.article, scheme);
    this.enhance(); // re-draw diagrams with the matching Mermaid theme
  }

  // Outline

  buildToc() {
    this.tocItems = buildTocItems(collectHeadings(this.article));
    this.activeIndex = -1;
    this.toc.replaceChildren(
      ...(this.tocItems.length
        ? this.tocItems.map((item) => item.link)
        : [h('div', { class: 'mdp-toc-empty' }, t('tocEmpty'))]),
    );
    this.updateActiveHeading();
  }

  updateActiveHeading() {
    const headings = this.tocItems.map((item) => item.heading);
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const index = atBottom && window.scrollY > 0 ? headings.length - 1 : currentHeadingIndex(headings, ACTIVE_HEADING_OFFSET);
    if (index === this.activeIndex) return;
    this.tocItems[this.activeIndex]?.link.classList.remove('mdp-active');
    this.activeIndex = index;
    const link = this.tocItems[index]?.link;
    if (!link) return;
    link.classList.add('mdp-active');
    // Keep the active entry visible without scrolling the page itself.
    const linkRect = link.getBoundingClientRect();
    const tocRect = this.toc.getBoundingClientRect();
    if (linkRect.top < tocRect.top) this.toc.scrollTop -= tocRect.top - linkRect.top + 24;
    else if (linkRect.bottom > tocRect.bottom) this.toc.scrollTop += linkRect.bottom - tocRect.bottom + 24;
  }

  onTocClick(event) {
    if (event.target.closest('a') && this.narrow.matches) this.setTocOpen(false);
  }

  setTocOpen(open) {
    document.documentElement.classList.toggle('mdp-toc-open', open);
    this.buttons.toc.setAttribute('aria-pressed', String(open));
  }

  toggleToc() {
    const open = !document.documentElement.classList.contains('mdp-toc-open');
    this.setTocOpen(open);
    // The drawer on narrow windows is transient; remember the choice otherwise.
    if (!this.narrow.matches) saveSettings({ toc: open });
  }

  // Toolbar actions

  cycleTheme() {
    const next = THEME_MODES[(THEME_MODES.indexOf(this.theme.mode) + 1) % THEME_MODES.length];
    this.settings = { ...this.settings, theme: next };
    this.applyAppearance();
    saveSettings({ theme: next });
  }

  updateThemeButton() {
    const mode = this.theme.mode;
    const label = t('actionTheme', t(`theme_${mode}`));
    Object.assign(this.buttons.theme, { innerHTML: icons[mode], title: label });
    this.buttons.theme.setAttribute('aria-label', label);
  }

  toggleSource() {
    this.showingSource = !this.showingSource;
    if (this.showingSource) this.renderSource();
    this.sourceView.hidden = !this.showingSource;
    this.article.hidden = this.showingSource;
    const label = t(this.showingSource ? 'actionViewRendered' : 'actionViewSource');
    const button = this.buttons.source;
    Object.assign(button, { innerHTML: this.showingSource ? icons.eye : icons.code, title: label });
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(this.showingSource));
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  renderSource() {
    const code = h('code');
    const highlighted = this.source.length <= MAX_HIGHLIGHTED_SOURCE ? highlight(this.source, 'markdown') : '';
    if (highlighted) code.innerHTML = highlighted;
    else code.textContent = this.source;
    this.sourceView.replaceChildren(code);
  }

  updateStats() {
    const text = this.article.textContent;
    const cjk = text.match(CJK_RE)?.length ?? 0;
    const words = text.replace(CJK_RE, ' ').match(WORD_RE)?.length ?? 0;
    const minutes = Math.max(1, Math.round(cjk / 400 + words / 200));
    const count = new Intl.NumberFormat(chrome.i18n.getUILanguage()).format(cjk + words);
    this.stats.textContent = t('stats', [count, String(minutes)]);
  }

  showToast(message) {
    this.toast.textContent = message;
    this.toast.classList.add('mdp-show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('mdp-show'), 1600);
  }

  // Auto-reload for local files: poll the file through the background worker
  // while the tab is visible and re-render when its content changes.

  isWatching() {
    return location.protocol === 'file:' && this.settings.autoReload;
  }

  startWatching() {
    const generation = ++this.watchGeneration;
    clearTimeout(this.watchTimer);
    if (!this.isWatching()) return;
    const interval = clamp(Number(this.settings.reloadInterval) || 1000, 250, 60_000);
    const tick = async () => {
      if (document.visibilityState === 'visible') await this.checkForChanges();
      if (generation !== this.watchGeneration) return;
      this.watchTimer = setTimeout(tick, Math.min(interval * 2 ** this.watchFailures, 30_000));
    };
    this.watchTimer = setTimeout(tick, interval);
  }

  async checkForChanges() {
    if (this.checking) return;
    this.checking = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'mdp:fetch',
        charset: document.characterSet,
        hash: this.fileHash,
      });
      if (!response || response.error) throw new Error(response?.error ?? 'No response');
      this.watchFailures = 0;
      this.fileHash = response.hash;
      if (response.text === undefined) return;
      const text = normalizeNewlines(response.text);
      if (text === this.source) return;
      this.source = text;
      await this.rerender();
      this.showToast(t('fileUpdated'));
    } catch {
      if (!chrome.runtime?.id) {
        this.watchGeneration++; // the extension was reloaded or removed
        return;
      }
      this.watchFailures = Math.min(this.watchFailures + 1, 5);
    } finally {
      this.checking = false;
    }
  }
}

const libraries = new Map();

// Libraries are injected into this page's isolated world by the background
// worker, where they define window.katex / window.mermaid.
function loadLib(name) {
  if (!libraries.has(name)) {
    const promise = chrome.runtime
      .sendMessage({ type: 'mdp:load-lib', lib: name })
      .then((response) => {
        if (response?.error) throw new Error(response.error);
        if (!globalThis[name]) throw new Error(`${name} did not load`);
        return globalThis[name];
      })
      .catch((err) => {
        libraries.delete(name);
        throw err;
      });
    libraries.set(name, promise);
  }
  return libraries.get(name);
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeDecodeURI(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function fileName() {
  const last = location.pathname.split('/').pop();
  return (last && safeDecodeURI(last)) || location.host || 'Markdown';
}

// Tracks whether the reader scrolls on their own. Comparing scroll positions
// is not enough: scroll anchoring moves the page when content above grows.
function watchReaderScroll() {
  const events = ['wheel', 'touchmove', 'keydown', 'mousedown'];
  const reader = {
    scrolled: false,
    stop: () => events.forEach((type) => window.removeEventListener(type, onInput, true)),
  };
  const onInput = () => {
    reader.scrolled = true;
    reader.stop();
  };
  events.forEach((type) => window.addEventListener(type, onInput, { capture: true, passive: true }));
  return reader;
}

function scrollToFragment(fragment) {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // keep the raw fragment
  }
  const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
  target?.scrollIntoView({ behavior: 'instant' });
}

// Scroll position survives reloads via sessionStorage, which may be
// unavailable (sandboxed documents), hence the try/catch.
const scrollKey = () => `mdp-scroll:${location.href.split('#')[0]}`;

function storeScroll(y) {
  try {
    sessionStorage.setItem(scrollKey(), String(Math.round(y)));
  } catch {
    // ignore
  }
}

function takeStoredScroll() {
  try {
    const value = Number(sessionStorage.getItem(scrollKey()));
    sessionStorage.removeItem(scrollKey());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
