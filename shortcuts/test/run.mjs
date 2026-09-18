import assert from 'node:assert/strict';
import { installChrome } from './harness.mjs';
import fs from 'node:fs';

const DIR = new URL('../', import.meta.url).pathname;
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

installChrome({ delay: 0 });
const A = await import(DIR + 'actions.js');
const K = globalThis.ShortcutKeys;

console.log('\n— keys.js —');
await t('parseCombo splits modifiers', () => {
  assert.deepEqual(K.parseCombo('Ctrl+a'), { mods: ['Ctrl'], key: 'a' });
  assert.deepEqual(K.parseCombo('Ctrl+Shift+ArrowLeft'), { mods: ['Ctrl','Shift'], key: 'ArrowLeft' });
  assert.deepEqual(K.parseCombo('l'), { mods: [], key: 'l' });
});
await t('parseCombo survives "+" as the bound key (old split() lost it)', () => {
  assert.deepEqual(K.parseCombo('+'), { mods: [], key: '+' });
  assert.deepEqual(K.parseCombo('Ctrl++'), { mods: ['Ctrl'], key: '+' });
  // what the old code did:
  assert.equal('Ctrl++'.split('+').pop(), '');
});
await t('comboLabel renders invisible keys', () => {
  assert.equal(K.comboLabel(' '), 'Space');
  assert.equal(K.comboLabel('Ctrl+a'), 'Ctrl + A');
  assert.equal(K.comboLabel('ArrowLeft'), '←');
  assert.equal(K.comboLabel('Ctrl++'), 'Ctrl + +');
});
await t('comboFromEvent round-trips through parseCombo', () => {
  const e = { key: 'A', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(K.comboFromEvent(e), 'Ctrl+a');
  assert.equal(K.comboFromEvent({ key: '+', ctrlKey: true }), 'Ctrl++');
});
await t('isUnsafePrefix flags bare printable keys only', () => {
  assert.equal(K.isUnsafePrefix('a'), true);
  assert.equal(K.isUnsafePrefix('Ctrl+a'), false);
  assert.equal(K.isUnsafePrefix('F1'), false);
});

console.log('\n— config —');
await t('normalizeConfig repairs junk', () => {
  const c = A.normalizeConfig({ timeoutMs: 999999, bindings: { l: 'nope', n: 'next-tab' }, prefix: '' });
  assert.equal(c.timeoutMs, A.TIMEOUT_MAX);
  assert.deepEqual(c.bindings, { n: 'next-tab' });   // dead action dropped
  assert.equal(c.prefix, 'Ctrl+a');
  assert.equal(c.enabled, true);
});
await t('normalizeConfig of undefined = defaults', () => {
  assert.deepEqual(A.normalizeConfig(undefined), A.DEFAULT_CONFIG);
});
await t('migrateConfig: no spurious write for a current config', () => {
  const { changed } = A.migrateConfig(structuredClone(A.DEFAULT_CONFIG));
  assert.equal(changed, false, 'would rewrite config on every browser start');
});
await t('migrateConfig: binds a genuinely new action', () => {
  const legacy = structuredClone(A.DEFAULT_CONFIG);
  legacy.knownActions = legacy.knownActions.filter((id) => id !== 'pin-tab');
  delete legacy.bindings['i'];
  const { config, changed } = A.migrateConfig(legacy);
  assert.equal(changed, true);
  assert.equal(config.bindings['i'], 'pin-tab');
});
await t('migrateConfig: does NOT resurrect a binding the user cleared', () => {
  const cleared = structuredClone(A.DEFAULT_CONFIG);
  delete cleared.bindings['r'];                     // user cleared "reload tab"
  const { config } = A.migrateConfig(cleared);
  assert.equal(config.bindings['r'], undefined);
});
await t('migrateConfig: legacy config (no knownActions) is left alone', () => {
  const legacy = { enabled: true, prefix: 'Ctrl+a', bindings: { l: 'last-tab' }, ignoreInInputs: false, showCheatsheet: true, timeoutMs: 3000 };
  const { config } = A.migrateConfig(legacy);
  assert.deepEqual(config.bindings, { l: 'last-tab' }, 'should not inject 13 bindings');
});

console.log('\n— tab history —');
await t('recordActivation survives concurrent calls (the race)', async () => {
  const { areas } = installChrome({ delay: 1 });
  const M = await import(DIR + 'actions.js?race=' + Math.random());
  await Promise.all([1,2,3,4,5,6].map((id) => M.recordActivation(7, id)));
  assert.deepEqual(areas.session.tabHistory[7], [6,5,4,3,2,1]);
});
await t('forgetTab / forgetWindow prune', async () => {
  const { areas } = installChrome({ delay: 1 });
  const M = await import(DIR + 'actions.js?p=' + Math.random());
  await M.recordActivation(1, 10); await M.recordActivation(1, 11); await M.recordActivation(2, 20);
  await M.forgetTab(10);
  assert.deepEqual(areas.session.tabHistory[1], [11]);
  await M.forgetWindow(2);
  assert.equal(2 in areas.session.tabHistory, false);
});

const tabsFor = (spec) => spec.map((s, i) => ({ id: s.id, index: i, windowId: s.w ?? 1, active: !!s.a, pinned: !!s.p }));
const load = () => import(DIR + 'actions.js?n=' + Math.random());

console.log('\n— tab actions —');

await t('next/prev tab wrap around', async () => {
  const { state } = installChrome({ tabs: tabsFor([{id:1},{id:2,a:1},{id:3}]) });
  const A = await load();
  await A.ACTIONS['next-tab'].run({ tab: { windowId: 1 } });
  assert.equal(state.tabs.find(x=>x.active).id, 3);
  await A.ACTIONS['next-tab'].run({ tab: { windowId: 1 } });
  assert.equal(state.tabs.find(x=>x.active).id, 1, 'should wrap to first');
  await A.ACTIONS['prev-tab'].run({ tab: { windowId: 1 } });
  assert.equal(state.tabs.find(x=>x.active).id, 3, 'should wrap to last');
});

await t('single-tab window: next-tab is a safe no-op', async () => {
  const { state } = installChrome({ tabs: tabsFor([{id:1,a:1}]) });
  const A = await load();
  await A.ACTIONS['next-tab'].run({ tab: { windowId: 1 } });
  assert.equal(state.calls.filter(c=>c.startsWith('activate')).length, 0);
});

await t('move-tab-right on an UNPINNED tab never lands in the pinned strip', async () => {
  // pinned 1,2 | unpinned 3(active),4
  const { state } = installChrome({ tabs: tabsFor([{id:1,p:1},{id:2,p:1},{id:3,a:1},{id:4}]) });
  const A = await load();
  await A.ACTIONS['move-tab-right'].run({ tab: { windowId: 1 } });
  assert.deepEqual(state.tabs.sort((a,b)=>a.index-b.index).map(x=>x.id), [1,2,4,3]);
});

await t('move-tab-left from the first unpinned slot wraps inside its own strip', async () => {
  const { state } = installChrome({ tabs: tabsFor([{id:1,p:1},{id:2,a:1},{id:3},{id:4}]) });
  const A = await load();
  await A.ACTIONS['move-tab-left'].run({ tab: { windowId: 1 } });
  const order = state.tabs.sort((a,b)=>a.index-b.index).map(x=>x.id);
  assert.deepEqual(order, [1,3,4,2], 'wraps to the end of the unpinned strip, pinned tab untouched');
  assert.equal(state.tabs.find(x=>x.id===1).index, 0, 'pinned tab must stay at 0');
});

console.log('\n— last-tab —');

await t('last-tab toggles between two tabs', async () => {
  const { state } = installChrome({ tabs: tabsFor([{id:1,a:1},{id:2}]) });
  const A = await load();
  await A.recordActivation(1, 1);
  await A.recordActivation(1, 2);   // user switched to tab 2
  await A.ACTIONS['last-tab'].run({ tab: { windowId: 1 } });
  assert.equal(state.calls.at(-1), 'activate 1');
});

await t('last-tab focuses the other window when the tab moved', async () => {
  const { state } = installChrome({ tabs: [
    { id: 1, index: 0, windowId: 2, active: true, pinned: false },
    { id: 9, index: 0, windowId: 1, active: true, pinned: false },
  ]});
  const A = await load();
  await A.recordActivation(1, 9);
  await A.recordActivation(1, 1);   // tab 1 has since been dragged to window 2
  await A.recordActivation(1, 5);
  await A.ACTIONS['last-tab'].run({ tab: { windowId: 1 } });
  assert.ok(state.calls.includes('focusWindow 2'), 'must raise the window, got ' + JSON.stringify(state.calls));
});

await t('last-tab drops a closed tab instead of dead-ending', async () => {
  const { areas } = installChrome({ tabs: tabsFor([{id:1,a:1}]) });
  const A = await load();
  await A.recordActivation(1, 1);
  await A.recordActivation(1, 99);  // 99 no longer exists
  await A.recordActivation(1, 1);
  await A.ACTIONS['last-tab'].run({ tab: { windowId: 1 } });
  assert.equal(areas.session.tabHistory[1].includes(99), false, 'stale id should be pruned');
});

console.log('\n— tab picker —');

await t('defaults: w opens the picker, x closes the tab (tmux)', () => {
  assert.equal(A.DEFAULT_CONFIG.bindings.w, 'choose-tab');
  assert.equal(A.DEFAULT_CONFIG.bindings.x, 'close-tab');
});

await t('choose-tab lists this window in strip order, active tab marked', async () => {
  installChrome({ tabs: [
    { id: 2, index: 1, windowId: 1, active: true,  pinned: false, title: 'Two', url: 'https://www.example.com/a' },
    { id: 1, index: 0, windowId: 1, active: false, pinned: true,  title: '',    url: 'chrome://newtab/' },
    { id: 9, index: 0, windowId: 2, active: true,  pinned: false, title: 'Elsewhere', url: 'https://x.test/' },
  ]});
  const A = await load();
  const { tabs } = await A.ACTIONS['choose-tab'].run({ tab: { windowId: 1 } });
  assert.deepEqual(tabs, [
    { id: 1, title: 'chrome://newtab/', host: 'chrome',      active: false, pinned: true },
    { id: 2, title: 'Two',              host: 'example.com', active: true,  pinned: false },
  ]);
});

await t('activateTab raises the window the tab lives in; false for a gone tab', async () => {
  const { state } = installChrome({ tabs: tabsFor([{id:1,a:1},{id:2,w:2,a:1}]) });
  const A = await load();
  assert.equal(await A.activateTab(2, 1), true);
  assert.ok(state.calls.includes('activate 2') && state.calls.includes('focusWindow 2'), JSON.stringify(state.calls));
  assert.equal(await A.activateTab(404, 1), false);
});

// A config written by 0.2.x: no picker yet, close-tab on its old default "w".
const prePicker = (bindings) => ({
  ...structuredClone(A.DEFAULT_CONFIG),
  bindings,
  knownActions: A.ACTION_IDS.filter((id) => id !== 'choose-tab'),
});

await t('migrateConfig: 0.2 config moves close-tab w→x and gives w to the picker', () => {
  const { config, changed } = A.migrateConfig(prePicker({ w: 'close-tab', l: 'last-tab' }));
  assert.equal(changed, true);
  assert.equal(config.bindings.w, 'choose-tab');
  assert.equal(config.bindings.x, 'close-tab');
  assert.equal(config.bindings.l, 'last-tab');
});

await t('migrateConfig: a user-chosen w binding is left alone', () => {
  const { config } = A.migrateConfig(prePicker({ w: 'reload-tab', x: 'close-tab' }));
  assert.equal(config.bindings.w, 'reload-tab');
  assert.equal(Object.values(config.bindings).includes('choose-tab'), false, 'picker must not steal a key');
});

await t('migrateConfig: close-tab keeps w when x is already taken', () => {
  const { config } = A.migrateConfig(prePicker({ w: 'close-tab', x: 'reload-tab' }));
  assert.equal(config.bindings.w, 'close-tab');
  assert.equal(config.bindings.x, 'reload-tab');
});

await t('migrateConfig: a current config is not rewritten', () => {
  assert.equal(A.migrateConfig(structuredClone(A.DEFAULT_CONFIG)).changed, false);
});

console.log('\n— content.js matchBinding / pickerCommand (extracted from the shipped source) —');

await t('content.js names the same picker action as actions.js', () => {
  const src = fs.readFileSync(DIR + 'content.js', 'utf8');
  const id = src.match(/PICKER_ACTION = '([^']+)'/)?.[1];
  assert.ok(A.ACTIONS[id], `PICKER_ACTION "${id}" is not a registered action`);
});

await t('chord matches with the prefix modifier still held', async () => {
  installChrome({});
  await import(DIR + 'keys.js?n=' + Math.random());
  const src = fs.readFileSync(DIR + 'content.js', 'utf8');
  const body = src.slice(src.indexOf('function withoutPrefixMods'), src.indexOf('// composedPath()'));
  const { parseCombo } = globalThis.ShortcutKeys;
  let config = { prefix: 'Ctrl+a', bindings: { l: 'last-tab', '+': 'zoom', 'Shift+g': 'end' } };
  const { matchBinding, pickerCommand } = new Function('parseCombo', 'getConfig',
    body.replace(/config\?\./g, 'getConfig().').replace(/\bconfig\./g, 'getConfig().') +
    '\nreturn { matchBinding, pickerCommand };')(parseCombo, () => config);

  assert.equal(pickerCommand('Ctrl+n'), 'down');
  assert.equal(pickerCommand('ArrowUp'), 'up');
  assert.equal(pickerCommand('Ctrl+Enter'), 'choose', 'Enter with the prefix modifier still held');
  assert.equal(pickerCommand('Escape'), 'cancel');
  assert.equal(pickerCommand('n'), null, 'bare n is not a picker key');
  assert.equal(pickerCommand('Shift+ArrowDown'), null);

  assert.equal(matchBinding('l'), 'last-tab', 'plain key');
  assert.equal(matchBinding('Ctrl+l'), 'last-tab', 'Ctrl still held from the prefix');
  assert.equal(matchBinding('Shift+g'), 'end', 'exact modified binding');
  assert.equal(matchBinding('Ctrl++'), 'zoom', '"+" key with the prefix modifier held');
  assert.equal(matchBinding('z'), undefined, 'unbound key');
  config = { prefix: 'Ctrl+a' };
  assert.equal(matchBinding('l'), undefined, 'missing bindings must not throw');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
