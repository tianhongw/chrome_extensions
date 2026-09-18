// Builds the extension into dist/.
//   node scripts/build.mjs          production build
//   node scripts/build.mjs --watch  rebuild on change (unminified, inline source maps)
//   node scripts/build.mjs --zip    production build + release/mdpreview-<version>.zip
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const modules = path.join(root, 'node_modules');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');

const shared = {
  absWorkingDir: root,
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'chrome123',
  outdir: dist,
  logLevel: 'warning',
};

const scripts = {
  ...shared,
  entryPoints: {
    background: 'src/background.js',
    detect: 'src/content/detect.js',
    viewer: 'src/content/viewer.js',
    popup: 'src/pages/popup.js',
    options: 'src/pages/options.js',
    editor: 'src/pages/editor.js',
  },
  format: 'iife',
  // The viewer injects its styles itself, so it imports CSS as text.
  loader: { '.css': 'text' },
};

const styles = {
  ...shared,
  entryPoints: {
    popup: 'src/pages/popup.css',
    options: 'src/pages/options.css',
    editor: 'src/pages/editor.css',
  },
};

function copy(from, to, transform) {
  const target = path.join(dist, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (transform) fs.writeFileSync(target, transform(fs.readFileSync(from, 'utf8')));
  else fs.copyFileSync(from, target);
}

function copyDir(from, to, filter = () => true) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) copyDir(source, path.join(to, entry.name), filter);
    else if (filter(entry.name)) copy(source, path.join(to, entry.name));
  }
}

const stripSourceMap = (code) => code.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');

function copyStatic() {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const page of ['popup', 'options', 'editor']) copy(path.join(src, 'pages', `${page}.html`), `${page}.html`);
  copyDir(path.join(src, 'icons'), 'icons', (name) => name.endsWith('.png'));
  copyDir(path.join(src, '_locales'), '_locales');
  copyDir(path.join(src, 'demo'), 'demo');

  // KaTeX: Chrome only needs the woff2 fonts, so drop the woff/ttf fallbacks.
  const katex = path.join(modules, 'katex', 'dist');
  copy(path.join(katex, 'katex.min.js'), 'vendor/katex/katex.min.js', stripSourceMap);
  copy(path.join(katex, 'katex.min.css'), 'vendor/katex/katex.min.css', (css) =>
    css.replace(/,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, ''),
  );
  copyDir(path.join(katex, 'fonts'), 'vendor/katex/fonts', (name) => name.endsWith('.woff2'));
  copy(path.join(modules, 'mermaid', 'dist', 'mermaid.min.js'), 'vendor/mermaid/mermaid.min.js', stripSourceMap);

  // License texts of everything bundled or vendored.
  for (const dep of Object.keys(pkg.dependencies)) {
    const dir = path.join(modules, dep);
    const license = fs.readdirSync(dir).find((name) => /^licen[cs]e/i.test(name));
    if (license) copy(path.join(dir, license), `licenses/${dep.replace('/', '__')}.txt`);
  }
}

function packageZip() {
  const release = path.join(root, 'release');
  const file = path.join(release, `mdpreview-${pkg.version}.zip`);
  fs.mkdirSync(release, { recursive: true });
  fs.rmSync(file, { force: true });
  execFileSync('zip', ['-qrX', file, '.'], { cwd: dist });
  console.log(`Packaged ${path.relative(root, file)}`);
}

fs.rmSync(dist, { recursive: true, force: true });
copyStatic();

if (watch) {
  const contexts = await Promise.all([esbuild.context(scripts), esbuild.context(styles)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  let timer;
  fs.watch(src, { recursive: true }, (event, file) => {
    if (!file || /\.(?:js|css)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      copyStatic();
      console.log(`Copied static files (${file})`);
    }, 100);
  });
  console.log('Watching for changes… (reload the extension in chrome://extensions after edits)');
} else {
  await Promise.all([esbuild.build(scripts), esbuild.build(styles)]);
  console.log(`Built ${path.relative(root, dist)}/ (v${pkg.version})`);
  if (zip) packageZip();
}
