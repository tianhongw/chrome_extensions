import {
  ACTIONS,
  DEFAULT_CONFIG,
  CONFIG_KEY,
  TIMEOUT_MIN,
  TIMEOUT_MAX,
  comboFromEvent,
  comboLabel,
  isModifierKey,
  isUnsafePrefix,
  normalizeConfig,
} from './actions.js';

const els = {
  enabled: document.getElementById('enabled'),
  ignoreInInputs: document.getElementById('ignoreInInputs'),
  showCheatsheet: document.getElementById('showCheatsheet'),
  timeoutMs: document.getElementById('timeoutMs'),
  prefixDisplay: document.getElementById('prefix-display'),
  prefixRecord: document.getElementById('prefix-record'),
  actions: document.getElementById('actions'),
  save: document.getElementById('save'),
  revert: document.getElementById('revert'),
  reset: document.getElementById('reset'),
  dirty: document.getElementById('dirty'),
  toast: document.getElementById('toast'),
};

// Working copy, edited in memory until "Save"; `saved` mirrors what is actually
// in storage so we can tell whether there is anything to save.
let config = structuredClone(DEFAULT_CONFIG);
let saved = structuredClone(DEFAULT_CONFIG);
let recordingButton = null; // the button currently waiting for a keypress

// Order-independent serialisation, so re-adding a binding in a different order
// doesn't read as an unsaved change.
function canon(c) {
  return JSON.stringify({
    enabled: c.enabled,
    ignoreInInputs: c.ignoreInInputs,
    showCheatsheet: c.showCheatsheet,
    timeoutMs: c.timeoutMs,
    prefix: c.prefix,
    bindings: Object.keys(c.bindings)
      .sort()
      .map((k) => [k, c.bindings[k]]),
  });
}

const isDirty = () => canon(config) !== canon(saved);

function comboForAction(actionId) {
  return Object.keys(config.bindings).find((c) => config.bindings[c] === actionId);
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function syncDirtyUi() {
  const dirty = isDirty();
  els.dirty.textContent = dirty ? 'Unsaved changes' : '';
  els.save.disabled = !dirty;
  els.revert.disabled = !dirty;
}

// --- rendering --------------------------------------------------------------
function render() {
  els.enabled.checked = !!config.enabled;
  els.ignoreInInputs.checked = !!config.ignoreInInputs;
  els.showCheatsheet.checked = config.showCheatsheet !== false;
  els.timeoutMs.value = config.timeoutMs;
  els.prefixDisplay.textContent = comboLabel(config.prefix);

  els.actions.replaceChildren();
  for (const [id, action] of Object.entries(ACTIONS)) {
    const combo = comboForAction(id);

    const row = document.createElement('div');
    row.className = 'row';

    const info = document.createElement('div');
    info.className = 'grow';
    const title = document.createElement('div');
    title.textContent = action.label;
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = action.description;
    info.append(title, desc);

    const key = document.createElement('kbd');
    key.textContent = combo ? comboLabel(combo) : 'unset';
    if (!combo) key.classList.add('empty');

    const setBtn = document.createElement('button');
    setBtn.textContent = 'Set';
    setBtn.addEventListener('click', () => startRecording(setBtn, id));

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.disabled = !combo;
    clearBtn.addEventListener('click', () => {
      if (combo) delete config.bindings[combo];
      render();
    });

    row.append(info, key, setBtn, clearBtn);
    els.actions.appendChild(row);
  }
  syncDirtyUi();
}

// --- key recording ----------------------------------------------------------
function startRecording(button, target) {
  cancelRecording();
  recordingButton = button;
  button.classList.add('recording');
  button.textContent = 'Press key…';
  button.dataset.target = target; // 'prefix' or an action id
}

function cancelRecording() {
  if (!recordingButton) return;
  recordingButton.classList.remove('recording');
  recordingButton.textContent =
    recordingButton.dataset.target === 'prefix' ? 'Change' : 'Set';
  delete recordingButton.dataset.target;
  recordingButton = null;
}

function recordPrefix(combo) {
  if (combo === config.prefix) return true;
  if (
    isUnsafePrefix(combo) &&
    !confirm(
      `Use ${comboLabel(combo)} as the prefix?\n\n` +
        'It has no modifier, so every time you type that character on a page ' +
        'the extension will swallow it and wait for a second key.',
    )
  ) {
    return false;
  }
  const owner = config.bindings[combo];
  config.prefix = combo;
  if (owner) {
    toast(
      `Prefix set. Note: ${comboLabel(combo)} is also bound to “${ACTIONS[owner].label}”.`,
    );
  }
  return true;
}

function recordBinding(combo, actionId) {
  // Validate before mutating: an early return after deleting the old binding
  // would leave the action unbound even though nothing was reassigned.
  if (combo === config.prefix) {
    toast('That key is the prefix — pick another.');
    return false;
  }
  if (config.bindings[combo] === actionId) return true; // unchanged

  const previousOwner = config.bindings[combo];
  const existing = comboForAction(actionId);
  if (existing) delete config.bindings[existing];
  config.bindings[combo] = actionId;

  if (previousOwner) {
    toast(`${comboLabel(combo)} taken from “${ACTIONS[previousOwner].label}”.`);
  }
  return true;
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!recordingButton) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cancelRecording();
      return;
    }
    if (isModifierKey(e.key)) return; // wait for a non-modifier key

    const combo = comboFromEvent(e);
    const target = recordingButton.dataset.target;
    if (!combo) return;

    // cancelRecording() first: recordPrefix may open a confirm() dialog, and
    // render() below rebuilds the button we are holding a reference to.
    cancelRecording();
    if (target === 'prefix') recordPrefix(combo);
    else recordBinding(combo, target);
    render();
  },
  true,
);

els.prefixRecord.addEventListener('click', () =>
  startRecording(els.prefixRecord, 'prefix'),
);

// --- general settings -------------------------------------------------------
els.enabled.addEventListener('change', () => {
  config.enabled = els.enabled.checked;
  syncDirtyUi();
});
els.ignoreInInputs.addEventListener('change', () => {
  config.ignoreInInputs = els.ignoreInInputs.checked;
  syncDirtyUi();
});
els.showCheatsheet.addEventListener('change', () => {
  config.showCheatsheet = els.showCheatsheet.checked;
  syncDirtyUi();
});
els.timeoutMs.addEventListener('change', () => {
  const v = parseInt(els.timeoutMs.value, 10);
  if (Number.isFinite(v)) {
    config.timeoutMs = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, v));
  }
  els.timeoutMs.value = config.timeoutMs;
  syncDirtyUi();
});

// --- save / revert / reset --------------------------------------------------
async function persist(next, message) {
  config = next;
  await chrome.storage.sync.set({ [CONFIG_KEY]: config });
  saved = structuredClone(config);
  render();
  toast(message);
}

els.save.addEventListener('click', () => persist(config, 'Saved'));

els.revert.addEventListener('click', () => {
  config = structuredClone(saved);
  render();
  toast('Reverted to the saved settings');
});

els.reset.addEventListener('click', () => {
  if (!confirm('Reset the prefix, every binding, and all settings to their defaults?')) {
    return;
  }
  persist(structuredClone(DEFAULT_CONFIG), 'Reset to defaults');
});

window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

// Another context (the popup's on/off switch, or a second options tab) can
// write the config while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[CONFIG_KEY]) return;
  const incoming = normalizeConfig(changes[CONFIG_KEY].newValue);
  if (canon(incoming) === canon(saved)) return;

  const wasDirty = isDirty();
  saved = incoming;
  if (!wasDirty) {
    config = structuredClone(incoming);
    render();
  } else {
    syncDirtyUi();
    toast('Settings changed elsewhere — saving will overwrite them.');
  }
});

// --- init -------------------------------------------------------------------
chrome.storage.sync.get(CONFIG_KEY).then((res) => {
  saved = normalizeConfig(res[CONFIG_KEY]);
  config = structuredClone(saved);
  render();
});
