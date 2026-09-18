// End-to-end tests: loads dist/ as an unpacked extension in Playwright's
// Chromium and exercises it on local files, a local HTTP server and the
// extension's own pages. Run `npm test` (builds first).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const fixtures = path.join(import.meta.dirname, 'fixtures');
const sampleUrl = pathToFileURL(path.join(fixtures, 'sample.md')).href;

let context;
let extensionId;
let server;
let baseUrl;
let tmpDir;

const routes = {
  '/plain/sample.md': ['text/plain; charset=utf-8', fs.readFileSync(path.join(fixtures, 'sample.md'))],
  '/typed/README': ['text/markdown; charset=utf-8', '# Typed\n\nServed as `text/markdown` without an extension.\n'],
  '/html/page.md': ['text/html; charset=utf-8', '<!doctype html><title>HTML</title><h1 id="html">HTML page</h1>'],
  '/plain/notes.txt': ['text/plain; charset=utf-8', '# Not Markdown\n\nJust a text file.\n'],
  // A page CSP must not stop the viewer; the second one mimics raw.githubusercontent.com.
  '/csp/strict.md': ['text/plain; charset=utf-8', fs.readFileSync(path.join(fixtures, 'sample.md')), "default-src 'none'"],
  '/csp/sandbox.md': [
    'text/plain; charset=utf-8',
    fs.readFileSync(path.join(fixtures, 'sample.md')),
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  ],
};

before(async () => {
  assert.ok(fs.existsSync(path.join(dist, 'manifest.json')), 'run `npm run build` first');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdpreview-test-'));
  server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, 'http://localhost').pathname];
    const headers = { 'content-type': route?.[0] ?? 'text/plain' };
    if (route?.[2]) headers['content-security-policy'] = route[2];
    res.writeHead(route ? 200 : 404, headers);
    res.end(route?.[1] ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  context = await chromium.launchPersistentContext(path.join(tmpDir, 'profile'), {
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  await context?.close();
  server?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function open(url) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`[pageerror] ${url}:`, err));
  await page.goto(url);
  return page;
}

async function openRendered(url) {
  const page = await open(url);
  await page.waitForSelector('html.mdp .markdown-body h1');
  return page;
}

// Runs fn(args) in an extension page, where chrome.* APIs are available.
async function inExtension(fn, args) {
  const page = await open(`chrome-extension://${extensionId}/popup.html`);
  try {
    return await page.evaluate(fn, args);
  } finally {
    await page.close();
  }
}

const setSettings = (values) => inExtension((v) => chrome.storage.sync.set(v), values);
const getSettings = () => inExtension(() => chrome.storage.sync.get(null));

describe('local files', () => {
  test('renders Markdown with GitHub-compatible structure', async () => {
    const page = await openRendered(sampleUrl);
    const info = await page.evaluate(() => {
      const body = document.querySelector('.markdown-body');
      const $$ = (selector) => [...body.querySelectorAll(selector)];
      return {
        title: document.title,
        hidden: document.documentElement.style.visibility,
        ids: $$('h1, h2, h3').map((h) => h.id),
        tocLinks: [...document.querySelectorAll('.mdp-toc-item')].map((a) => a.getAttribute('href')),
        keywords: $$('.hljs-keyword').length,
        copyButtons: $$('.mdp-copy').length,
        checkboxes: $$('input[type=checkbox]').map((c) => [c.checked, c.disabled]),
        tableHeaders: $$('th').length,
        alerts: $$('.markdown-alert').map((a) => a.className),
        footnote: body.querySelector('.footnotes li')?.textContent.trim(),
        frontMatter: body.querySelector('details.mdp-front-matter')?.textContent,
        text: body.textContent,
        links: $$('a[href]').map((a) => a.getAttribute('href')),
        stats: document.querySelector('.mdp-stats')?.textContent,
      };
    });

    assert.equal(info.title, 'Sample Document');
    assert.equal(info.hidden, '');
    assert.deepEqual(info.ids.slice(0, 5), ['hello-world', 'title', 'duplicate', 'duplicate-1', '中文标题']);
    assert.equal(info.tocLinks.length, info.ids.length);
    assert.equal(info.tocLinks[4], `#${encodeURIComponent('中文标题')}`);
    assert.ok(info.keywords >= 2, 'JavaScript is highlighted');
    assert.equal(info.copyButtons, 2);
    assert.deepEqual(info.checkboxes, [
      [true, true],
      [false, true],
    ]);
    assert.equal(info.tableHeaders, 3);
    assert.deepEqual(info.alerts, ['markdown-alert markdown-alert-note', 'markdown-alert markdown-alert-warning']);
    assert.match(info.footnote, /The footnote text/);
    assert.match(info.frontMatter, /author: Test/);
    assert.match(info.text, /🚀/);
    assert.match(info.stats, /\d/);

    assert.ok(info.links.includes('file:///etc/hosts'), 'file: links are kept');
    assert.ok(info.links.includes('other.md#section'), 'relative links are kept');
    assert.ok(info.links.includes('http://www.example.com'), 'www. links are linkified');
    assert.ok(info.links.includes('https://example.org/path'));
    assert.ok(!info.links.some((href) => /README\.md|setup\.py/.test(href)), 'file names are not linkified');
    await page.close();
  });

  test('sanitizes unsafe HTML', async () => {
    const page = await openRendered(sampleUrl);
    await page.waitForSelector('.mdp-mermaid svg >> nth=1');
    await page.waitForSelector('.mdp-math.mdp-done');
    // Handlers would fire asynchronously (image errors, toggle, focus…).
    await page.waitForFunction(() => [...document.querySelectorAll('.markdown-body img')].every((img) => img.complete));
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => {
      const body = document.querySelector('.markdown-body');
      return {
        xss: window.__xss ?? null,
        handlers: [...body.querySelectorAll('*')].flatMap((el) => el.getAttributeNames()).filter((n) => n.startsWith('on')),
        scripts: body.querySelectorAll('script').length,
        iframes: body.querySelectorAll('iframe').length,
        styles: [...body.querySelectorAll('style')].filter((el) => !el.closest('.mdp-mermaid')).length,
        jsLinks: body.querySelectorAll('a[href^="javascript:" i]').length,
        bodyTag: document.body.tagName,
        bodyDisplay: getComputedStyle(document.body).display,
      };
    });
    assert.deepEqual(result, {
      xss: null,
      handlers: [],
      scripts: 0,
      iframes: 0,
      styles: 0,
      jsLinks: 0,
      bodyTag: 'BODY',
      bodyDisplay: 'block',
    });
    await page.close();
  });

  test('renders math with KaTeX and diagrams with Mermaid', async () => {
    const page = await openRendered(sampleUrl);
    await page.waitForSelector('.mdp-math.mdp-done .katex');
    await page.waitForSelector('.mdp-math-display .katex-display');
    await page.waitForSelector('.mdp-mermaid svg');
    await page.waitForSelector('.mdp-mermaid.mdp-error .mdp-error-message');
    const result = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        mathCount: document.querySelectorAll('.mdp-math').length,
        dollars: document.body.textContent.includes('money $5 and $10 stay text'),
        katexFont: getComputedStyle(document.querySelector('.katex')).fontFamily,
        katexFontLoaded: document.fonts.check('16px KaTeX_Main'),
        diagrams: document.querySelectorAll('.mdp-mermaid svg').length,
      };
    });
    assert.equal(result.mathCount, 3);
    assert.ok(result.dollars, 'currency amounts are not treated as math');
    assert.match(result.katexFont, /KaTeX_Main/);
    assert.ok(result.katexFontLoaded, 'KaTeX fonts load from the extension');
    assert.equal(result.diagrams, 2);
    await page.close();
  });

  test('toolbar toggles theme, source view and outline', async () => {
    const page = await openRendered(sampleUrl);
    const root = page.locator('html');
    const themeButton = page.locator('.mdp-toolbar .mdp-button').nth(1);

    await themeButton.click();
    await assert.doesNotReject(root.getAttribute('data-theme').then((v) => assert.equal(v, 'light')));
    await themeButton.click();
    assert.equal(await root.getAttribute('data-theme'), 'dark');
    assert.equal(await root.getAttribute('data-color-scheme'), 'dark');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(13, 17, 23)');
    await page.waitForSelector('.mdp-mermaid[data-rendered-key^="dark"]');
    assert.equal((await getSettings()).theme, 'dark');
    await themeButton.click();
    assert.equal(await root.getAttribute('data-theme'), 'auto');

    const sourceButton = page.locator('.mdp-toolbar .mdp-button').nth(2);
    await sourceButton.click();
    assert.ok(await page.locator('.mdp-source').isVisible());
    assert.ok(!(await page.locator('.markdown-body').isVisible()));
    assert.match(await page.locator('.mdp-source').textContent(), /^---\ntitle: Sample Document/);
    await sourceButton.click();
    assert.ok(await page.locator('.markdown-body').isVisible());

    assert.match((await root.getAttribute('class')) ?? '', /mdp-toc-open/);
    await page.locator('.mdp-toolbar .mdp-button').first().click();
    assert.doesNotMatch((await root.getAttribute('class')) ?? '', /mdp-toc-open/);
    await page.locator('.mdp-toolbar .mdp-button').first().click();
    assert.match((await root.getAttribute('class')) ?? '', /mdp-toc-open/);
    await page.close();
  });

  test('jumps to the URL fragment once diagrams have rendered', async () => {
    // The target sits below a diagram and a formula whose rendered size differs
    // from their placeholders, followed by enough text to scroll it to the top.
    const file = path.join(tmpDir, 'fragment.md');
    const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const diagram = '```mermaid\ngraph TD\n  A --> B\n  B --> C\n  C --> D\n  D --> E\n```';
    fs.writeFileSync(file, `# Top\n\n${diagram}\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n## Target\n\n${filler}\n`);
    const page = await openRendered(`${pathToFileURL(file).href}#target`);
    await page.waitForSelector('.mdp-mermaid svg');
    await page.waitForFunction(() => {
      const top = document.getElementById('target').getBoundingClientRect().top;
      return top >= 0 && top < 40;
    });
    await page.close();
  });

  test('auto-reloads when the file changes', async () => {
    const file = path.join(tmpDir, 'live.md');
    fs.writeFileSync(file, '# Live\n\nFirst version.\n');
    const page = await openRendered(pathToFileURL(file).href);
    fs.writeFileSync(file, '# Live\n\nSecond version.\n\n## Added Heading\n');
    await page.waitForSelector('#added-heading', { timeout: 5000 });
    assert.match(await page.locator('.markdown-body').textContent(), /Second version/);
    await page.waitForSelector('.mdp-toast.mdp-show');
    await page.close();
  });

  test('leaves files alone when rendering is disabled', async () => {
    await setSettings({ renderLocal: false });
    try {
      const page = await open(sampleUrl);
      await page.waitForTimeout(500);
      assert.equal(await page.locator('html.mdp').count(), 0);
      assert.ok(await page.locator('body > pre').isVisible());
      await page.close();
    } finally {
      await setSettings({ renderLocal: true });
    }
  });
});

describe('web pages', () => {
  test('renders .md served as text/plain', async () => {
    const page = await openRendered(`${baseUrl}/plain/sample.md`);
    assert.equal(await page.title(), 'Sample Document');
    await page.close();
  });

  test('works on pages with a restrictive or sandboxing CSP', async () => {
    for (const url of [`${baseUrl}/csp/strict.md`, `${baseUrl}/csp/sandbox.md`]) {
      const page = await openRendered(url);
      await page.waitForSelector('.mdp-mermaid svg', { timeout: 10000 });
      await page.waitForSelector('.mdp-math.mdp-done', { timeout: 10000 });
      const styled = await page.evaluate(() => ({
        weight: getComputedStyle(document.querySelector('.markdown-body h1')).fontWeight,
        sidebar: getComputedStyle(document.querySelector('.mdp-sidebar')).position,
        xss: window.__xss ?? null,
      }));
      assert.deepEqual(styled, { weight: '600', sidebar: 'fixed', xss: null }, url);
      await page.close();
    }
  });

  test('renders text/markdown responses without an extension', async () => {
    const page = await openRendered(`${baseUrl}/typed/README`);
    assert.equal(await page.locator('.markdown-body h1').textContent(), 'Typed');
    await page.close();
  });

  test('ignores HTML pages and non-Markdown text', async () => {
    for (const url of [`${baseUrl}/html/page.md`, `${baseUrl}/plain/notes.txt`]) {
      const page = await open(url);
      await page.waitForTimeout(500);
      assert.equal(await page.locator('html.mdp').count(), 0, url);
      assert.equal(await page.evaluate(() => document.documentElement.style.visibility), '', url);
      await page.close();
    }
  });

  test('renders any text page on demand (context menu / popup)', async () => {
    const page = await open(`${baseUrl}/plain/notes.txt`);
    await inExtension(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['viewer.js'] });
    }, `${baseUrl}/plain/notes.txt`);
    await page.waitForSelector('html.mdp .markdown-body h1');
    assert.equal(await page.locator('.markdown-body h1').textContent(), 'Not Markdown');
    await page.close();
  });
});

describe('extension pages', () => {
  test('editor renders as you type', async () => {
    const page = await open(`chrome-extension://${extensionId}/editor.html`);
    await page.locator('#source').fill('# Typed title\n\n- [x] task\n\n$x^2$\n');
    await page.waitForSelector('#preview h1#typed-title');
    await page.waitForSelector('#preview .katex');
    assert.match(await page.title(), /Markdown/);
    await page.close();
  });

  test('editor demo renders every feature', async () => {
    const page = await open(`chrome-extension://${extensionId}/editor.html?demo=1`);
    await page.waitForSelector('#preview .mdp-mermaid svg');
    await page.waitForSelector('#preview .katex-display');
    assert.equal(await page.locator('#preview .mdp-mermaid.mdp-error').count(), 0);
    assert.ok((await page.locator('#preview .hljs-keyword').count()) > 0);
    await page.close();
  });

  test('options page saves settings', async () => {
    const page = await open(`chrome-extension://${extensionId}/options.html`);
    const mathSwitch = page.locator('input[data-setting="math"]');
    await mathSwitch.waitFor();
    assert.ok(await mathSwitch.isChecked());
    await mathSwitch.click();
    await page.waitForFunction(async () => (await chrome.storage.sync.get('math')).math === false);
    await mathSwitch.click();
    await page.waitForFunction(async () => (await chrome.storage.sync.get('math')).math === true);
    assert.equal(await page.locator('#file-access').isHidden(), true);
    await page.close();
  });

  test('popup shows localized controls', async () => {
    const page = await open(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForFunction(() => document.getElementById('version').textContent.startsWith('v'));
    assert.ok(await page.locator('#enabled').isChecked());
    assert.notEqual((await page.locator('.title').textContent()).trim(), '');
    await page.close();
  });
});
