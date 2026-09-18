// Parser configuration (no browser needed): math and Mermaid placeholders,
// link policy, autolinks and front matter.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { frontMatterTitle, splitFrontMatter } from '../src/core/frontmatter.js';
import { createMarkdown } from '../src/core/markdown.js';
import { DEFAULTS } from '../src/shared/settings.js';

const md = createMarkdown(DEFAULTS);
const minimal = createMarkdown({ ...DEFAULTS, math: false, mermaid: false, html: false, emoji: false });

describe('math', () => {
  test('inline and display formulas become placeholders', () => {
    assert.equal(md.renderInline('$a_1 * b_2$'), '<span class="mdp-math">a_1 * b_2</span>');
    assert.equal(md.renderInline('\\(x\\)'), '<span class="mdp-math">x</span>');
    assert.equal(md.render('$$\nx^2\n$$'), '<div class="mdp-math mdp-math-display">x^2\n</div>\n');
    assert.equal(md.render('```math\nx\n```'), '<div class="mdp-math mdp-math-display">x\n</div>\n');
  });

  test('currency amounts are not math', () => {
    assert.equal(md.renderInline('costs $5 and $10'), 'costs $5 and $10');
  });

  test('can be disabled', () => {
    assert.equal(minimal.renderInline('$a$'), '$a$');
  });
});

describe('mermaid', () => {
  test('fences become escaped placeholders', () => {
    assert.equal(
      md.render('```mermaid\ngraph TD\nA-->B\n```'),
      '<div class="mdp-mermaid"><pre class="mdp-mermaid-source">graph TD\nA--&gt;B\n</pre></div>\n',
    );
  });

  test('stay code blocks when disabled', () => {
    assert.equal(minimal.render('```mermaid\ngraph TD\n```'), '<pre><code class="language-mermaid">graph TD\n</code></pre>\n');
  });
});

describe('links', () => {
  test('allows file: links and data: images, refuses script URLs', () => {
    const html = md.renderInline(
      '[a](file:///etc/hosts) [b](javascript:alert(1)) [c](JaVaScRiPt:x) [d](vbscript:x) [e](data:text/html,x) ![f](data:image/png;base64,AA)',
    );
    assert.match(html, /<a href="file:\/\/\/etc\/hosts">a<\/a>/);
    assert.match(html, /<img src="data:image\/png;base64,AA" alt="f">/);
    assert.doesNotMatch(html, /href="(?:javascript|vbscript|data):/i);
  });

  test('autolinks URLs and www. hosts but not file names', () => {
    assert.equal(
      md.renderInline('see www.example.com, https://x.org/a and README.md or setup.py'),
      'see <a href="http://www.example.com">www.example.com</a>, <a href="https://x.org/a">https://x.org/a</a> and README.md or setup.py',
    );
    assert.equal(md.renderInline('(www.github.com/a).'), '(<a href="http://www.github.com/a">www.github.com/a</a>).');
  });
});

describe('extensions', () => {
  test('GitHub alerts, task lists, footnotes and emoji', () => {
    assert.match(md.render('> [!WARNING]\n> careful'), /^<div class="markdown-alert markdown-alert-warning">/);
    assert.match(md.render('- [x] done'), /<input type="checkbox" class="task-list-item-checkbox" [^>]*checked/);
    assert.match(md.render('x[^1]\n\n[^1]: note'), /<section class="footnotes">/);
    assert.equal(md.renderInline(':rocket: :unknown:'), '🚀 :unknown:');
    assert.equal(minimal.renderInline(':rocket:'), ':rocket:');
  });

  test('highlights known languages and escapes the rest', () => {
    assert.match(md.render('```js\nconst a = 1;\n```'), /<span class="hljs-keyword">const<\/span>/);
    assert.equal(md.render('```nosuchlang\n<a>\n```'), '<pre><code class="language-nosuchlang">&lt;a&gt;\n</code></pre>\n');
  });

  test('raw HTML can be turned off', () => {
    assert.equal(minimal.render('<b>hi</b>'), '<p>&lt;b&gt;hi&lt;/b&gt;</p>\n');
  });
});

describe('front matter', () => {
  test('is split from the body', () => {
    assert.deepEqual(splitFrontMatter('---\ntitle: "Hi"\ntags: [a]\n---\n# Body\n'), {
      frontMatter: 'title: "Hi"\ntags: [a]',
      body: '# Body\n',
    });
    assert.equal(frontMatterTitle('title: "Hi"\ntags: [a]'), 'Hi');
    assert.equal(frontMatterTitle('tags: [a]'), null);
  });

  test('requires the opening fence on the first line', () => {
    const source = '# Title\n\n---\nnot: front matter\n---\n';
    assert.deepEqual(splitFrontMatter(source), { frontMatter: null, body: source });
  });
});
