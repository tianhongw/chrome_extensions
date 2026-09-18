// Every message key referenced in the source exists in every locale.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const src = path.resolve(import.meta.dirname, '..', 'src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '_locales' ? [] : sourceFiles(file);
    return /\.(?:js|html|json)$/.test(entry.name) ? [file] : [];
  });
}

function usedKeys() {
  const keys = new Set(['theme_auto', 'theme_light', 'theme_dark']); // built as `theme_${mode}`
  const patterns = [
    /\bt\('([\w@]+)'/g,
    /getMessage\('([\w@]+)'/g,
    /data-i18n(?:-title|-placeholder)?="([\w@]+)"/g,
    /__MSG_([\w@]+)__/g,
  ];
  for (const file of sourceFiles(src)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) for (const [, key] of text.matchAll(pattern)) keys.add(key);
  }
  return keys;
}

const locales = fs.readdirSync(path.join(src, '_locales'));

test('locales define every referenced message', () => {
  const keys = usedKeys();
  assert.ok(keys.size > 50);
  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(path.join(src, '_locales', locale, 'messages.json'), 'utf8'));
    const missing = [...keys].filter((key) => !(key in messages));
    assert.deepEqual(missing, [], `missing in ${locale}`);
  }
});

test('locales define the same keys', () => {
  const [first, ...rest] = locales.map((locale) =>
    Object.keys(JSON.parse(fs.readFileSync(path.join(src, '_locales', locale, 'messages.json'), 'utf8'))).sort(),
  );
  for (const keys of rest) assert.deepEqual(keys, first);
});
