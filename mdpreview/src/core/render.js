import GithubSlugger, { slug } from 'github-slugger';
import { copyText, h } from '../shared/dom.js';
import { t } from '../shared/i18n.js';
import { icons } from '../shared/icons.js';
import { frontMatterTitle, splitFrontMatter } from './frontmatter.js';
import { highlight } from './highlight.js';
import { sanitize } from './sanitize.js';

// Renders Markdown source to a sanitized, decorated DocumentFragment.
export function renderDocument(md, source) {
  const { frontMatter, body } = splitFrontMatter(source.replace(/^\uFEFF/, ''));
  const fragment = sanitize(md.render(body));
  if (frontMatter !== null) fragment.prepend(frontMatterBlock(frontMatter));
  decorateHeadings(fragment);
  decorateCodeBlocks(fragment);
  markColorSchemeSources(fragment);
  const h1 = fragment.querySelector('h1');
  return { fragment, title: frontMatterTitle(frontMatter) || (h1 && headingText(h1)) || null };
}

export function headingText(heading) {
  const clone = heading.cloneNode(true);
  for (const el of clone.querySelectorAll('.mdp-anchor, .footnote-ref')) el.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// GitHub-compatible ids ("Hello World" -> #hello-world, duplicates get -1, -2…)
// plus a hover link. Ids are assigned after sanitizing: DOMPurify strips ids
// that could clobber DOM globals (e.g. "title"), which are harmless on headings.
function decorateHeadings(root) {
  const slugger = new GithubSlugger();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (!heading.id) heading.id = slugger.slug(slug(headingText(heading)) || 'section');
    heading.prepend(
      h('a', {
        class: 'mdp-anchor',
        href: `#${encodeURIComponent(heading.id)}`,
        'aria-hidden': 'true',
        tabindex: '-1',
        html: icons.link,
      }),
    );
  }
}

function decorateCodeBlocks(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.firstElementChild;
    if (code?.tagName !== 'CODE' || pre.closest('.mdp-mermaid, .mdp-front-matter')) continue;
    const wrapper = h('div', { class: 'mdp-code' });
    pre.replaceWith(wrapper);
    wrapper.append(
      pre,
      h('button', { type: 'button', class: 'mdp-copy', title: t('copy'), 'aria-label': t('copy'), html: icons.copy }),
    );
  }
}

// Delegated click handler for the copy buttons added by decorateCodeBlocks.
export async function onCopyClick(event) {
  const button = event.target.closest?.('.mdp-copy');
  if (!button) return;
  const code = button.parentElement.querySelector(':scope > pre > code');
  if (!(await copyText(code?.textContent ?? ''))) return;
  button.innerHTML = icons.check;
  button.classList.add('mdp-copied');
  button.title = t('copied');
  setTimeout(() => {
    button.innerHTML = icons.copy;
    button.classList.remove('mdp-copied');
    button.title = t('copy');
  }, 1500);
}

function frontMatterBlock(yaml) {
  const code = h('code', { class: 'language-yaml' });
  const highlighted = highlight(yaml, 'yaml');
  if (highlighted) code.innerHTML = highlighted;
  else code.textContent = yaml;
  return h('details', { class: 'mdp-front-matter' }, h('summary', {}, t('frontMatter')), h('pre', {}, code));
}

const SCHEME_QUERY_RE = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;

function markColorSchemeSources(root) {
  for (const source of root.querySelectorAll('picture > source[media]')) {
    if (/prefers-color-scheme/i.test(source.media)) source.dataset.mdpMedia = source.media;
  }
}

// <picture> sources keyed on prefers-color-scheme follow the OS; make them
// follow the viewer's theme instead so logos stay readable on a forced theme.
export function applyColorSchemeToSources(root, scheme) {
  for (const source of root.querySelectorAll('source[data-mdp-media]')) {
    source.media = source.dataset.mdpMedia.replace(SCHEME_QUERY_RE, (_, value) =>
      value.toLowerCase() === scheme ? '(min-width: 0px)' : '(max-width: 0px)',
    );
  }
}
