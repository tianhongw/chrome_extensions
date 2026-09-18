import { h } from '../shared/dom.js';
import { headingText } from './render.js';

// How many levels below the top-most heading level appear in the outline.
const MAX_DEPTH = 3;

export function collectHeadings(root) {
  return [...root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')];
}

// Flat list of { heading, link } entries, links indented by depth; tolerant
// of skipped heading levels.
export function buildTocItems(headings) {
  if (!headings.length) return [];
  const levels = headings.map((el) => Number(el.tagName[1]));
  const top = Math.min(...levels);
  return headings.flatMap((heading, i) => {
    const depth = levels[i] - top;
    if (depth > MAX_DEPTH) return [];
    const text = headingText(heading);
    const link = h(
      'a',
      { class: 'mdp-toc-item', href: `#${encodeURIComponent(heading.id)}`, style: `--depth: ${depth}`, title: text },
      text,
    );
    return [{ heading, link }];
  });
}

// Index of the heading the reader is currently in: the last one whose top has
// scrolled past `offset` pixels from the top of the viewport. Headings hidden
// in a collapsed <details> have an empty rect and are skipped.
export function currentHeadingIndex(headings, offset) {
  let current = -1;
  for (let i = 0; i < headings.length; i++) {
    const rect = headings[i].getBoundingClientRect();
    if (!rect.height) continue;
    if (rect.top - offset > 0) break;
    current = i;
  }
  return current;
}
