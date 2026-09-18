import MarkdownIt from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import githubAlerts from 'markdown-it-github-alerts';
import { tasklist } from '@mdit/plugin-tasklist';
import { tex } from '@mdit/plugin-tex';
import { highlight } from './highlight.js';

// markdown-it rejects file: links by default; local documents link to each
// other that way, so only script-capable and non-image data URLs are refused.
const BAD_PROTOCOL_RE = /^(?:javascript|vbscript|data):/;
const DATA_IMAGE_RE = /^data:image\/(?:gif|png|jpeg|webp|avif|svg\+xml);/;

function validateLink(url) {
  const value = url.trim().toLowerCase();
  return !BAD_PROTOCOL_RE.test(value) || DATA_IMAGE_RE.test(value);
}

// Creates a markdown-it instance configured from the user's settings. Math and
// Mermaid blocks are emitted as placeholders that enhance.js renders lazily.
export function createMarkdown(settings) {
  const md = new MarkdownIt({
    html: settings.html,
    linkify: settings.linkify,
    breaks: settings.breaks,
    typographer: settings.typographer,
    highlight,
  });
  md.validateLink = validateLink;

  // Fuzzy links would turn file names such as README.md or setup.py into links
  // (.md and .py are country TLDs). Like GitHub, only link bare URLs starting with www.
  md.linkify.set({ fuzzyLink: false });
  md.linkify.add('www.', {
    // What follows "www." has the shape of a protocol-relative link's host and path.
    validate(text, pos, self) {
      const re = self.re.get_relative_proto_validator();
      re.lastIndex = pos;
      const match = re.exec(text);
      return match ? match[0].length : 0;
    },
    normalize(match) {
      match.url = `http://${match.url}`;
    },
  });

  md.use(footnote).use(githubAlerts).use(tasklist);
  if (settings.emoji) md.use(emoji);

  const escape = md.utils.escapeHtml;
  if (settings.math) {
    md.use(tex, {
      delimiters: 'all',
      mathFence: true,
      render: (content, displayMode) =>
        displayMode
          ? `<div class="mdp-math mdp-math-display">${escape(content)}</div>\n`
          : `<span class="mdp-math">${escape(content)}</span>`,
    });
  }

  if (settings.mermaid) {
    const fence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const lang = token.info.trim().split(/\s+/, 1)[0].toLowerCase();
      if (lang !== 'mermaid') return fence(tokens, idx, options, env, self);
      return `<div class="mdp-mermaid"><pre class="mdp-mermaid-source">${escape(token.content)}</pre></div>\n`;
    };
  }

  return md;
}
