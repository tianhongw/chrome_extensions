const CLOSE_ALL_CONFIRM_MS = 4000;

const state = {
  entries: [],
  visibleEntries: [],
  renderedGroups: new Map(),
  currentWindowId: null,
  showCurrentWindowOnly: false,
  terms: [],
  cursor: -1,
  closeAllArmed: false,
  closeAllTimer: null
};

const elements = {
  summary: document.querySelector("#summary"),
  status: document.querySelector("#status"),
  tabsRoot: document.querySelector("#tabsRoot"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  currentWindowButton: document.querySelector("#currentWindowButton"),
  duplicatesButton: document.querySelector("#duplicatesButton"),
  closeAllButton: document.querySelector("#closeAllButton"),
  groupTemplate: document.querySelector("#groupTemplate"),
  tabTemplate: document.querySelector("#tabTemplate")
};

document.addEventListener("DOMContentLoaded", () => {
  elements.searchInput.focus();
  bindEvents();
  loadTabs();
});

function bindEvents() {
  elements.searchInput.addEventListener("input", event => {
    state.terms = event.target.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    state.cursor = -1;
    disarmCloseAll();
    render();
  });

  elements.searchInput.addEventListener("keydown", handleSearchKeydown);
  document.addEventListener("keydown", handleGlobalKeydown);

  elements.refreshButton.addEventListener("click", () => loadTabs());

  elements.currentWindowButton.addEventListener("click", () => {
    state.showCurrentWindowOnly = countWindows(state.entries) > 1 && !state.showCurrentWindowOnly;
    state.cursor = -1;
    disarmCloseAll();
    render();
  });

  elements.duplicatesButton.addEventListener("click", closeDuplicateTabs);
  elements.closeAllButton.addEventListener("click", handleCloseAllClick);

  // One delegated listener for every row and group button instead of several per tab.
  elements.tabsRoot.addEventListener("click", handleTabsClick);
  elements.tabsRoot.addEventListener("error", handleFaviconError, true);
}

function handleSearchKeydown(event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveCursor(event.key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (event.key === "Enter") {
    const target = state.visibleEntries[state.cursor] ?? state.visibleEntries[0];

    if (target) {
      focusTab(target);
    }

    return;
  }

  if (event.key === "Escape" && elements.searchInput.value) {
    elements.searchInput.value = "";
    state.terms = [];
    state.cursor = -1;
    render();
  }
}

function handleGlobalKeydown(event) {
  const isPlainSlash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;

  if (!isPlainSlash || event.target === elements.searchInput) {
    return;
  }

  event.preventDefault();
  elements.searchInput.focus();
  elements.searchInput.select();
}

function handleTabsClick(event) {
  const trigger = event.target.closest("[data-action]");

  if (!trigger) {
    return;
  }

  const { action } = trigger.dataset;

  if (action === "close-group") {
    const group = state.renderedGroups.get(trigger.closest(".tab-group")?.dataset.groupKey);

    if (group) {
      closeTabGroup(group);
    }

    return;
  }

  const entry = findEntry(Number(trigger.closest(".tab-row")?.dataset.tabId));

  if (!entry) {
    return;
  }

  if (action === "focus") {
    focusTab(entry);
  } else if (action === "pin") {
    togglePinned(entry);
  } else if (action === "mute") {
    toggleMuted(entry);
  } else if (action === "close") {
    closeTab(entry);
  }
}

function handleFaviconError(event) {
  if (event.target.classList?.contains("favicon")) {
    event.target.closest(".favicon-wrap")?.classList.add("is-empty");
  }
}

function handleCloseAllClick() {
  if (!state.closeAllArmed) {
    armCloseAll();
    return;
  }

  disarmCloseAll();
  closeAllTabs();
}

function armCloseAll() {
  clearTimeout(state.closeAllTimer);
  state.closeAllArmed = true;
  state.closeAllTimer = setTimeout(() => {
    disarmCloseAll();
    updateCloseAllButton();
  }, CLOSE_ALL_CONFIRM_MS);
  updateCloseAllButton();
}

function disarmCloseAll() {
  clearTimeout(state.closeAllTimer);
  state.closeAllArmed = false;
  state.closeAllTimer = null;
}

function moveCursor(delta) {
  const count = state.visibleEntries.length;

  if (!count) {
    return;
  }

  const next = state.cursor < 0 && delta < 0 ? count - 1 : state.cursor + delta;
  state.cursor = Math.min(Math.max(next, 0), count - 1);
  applyCursor(true);
}

function applyCursor(scroll = false) {
  elements.tabsRoot.querySelector(".tab-row.is-cursor")?.classList.remove("is-cursor");

  const entry = state.visibleEntries[state.cursor];

  if (!entry) {
    return;
  }

  const row = elements.tabsRoot.querySelector(`.tab-row[data-tab-id="${entry.tab.id}"]`);

  if (!row) {
    return;
  }

  row.classList.add("is-cursor");

  if (scroll) {
    row.scrollIntoView({ block: "nearest" });
  }
}

async function loadTabs() {
  try {
    const [currentWindow, tabs] = await Promise.all([
      chrome.windows.getCurrent(),
      chrome.tabs.query({})
    ]);

    state.currentWindowId = currentWindow.id;
    setEntries(tabs);
    clearStatus();
    render();
  } catch (error) {
    setStatus(`Could not read tabs: ${error.message}`, true);
  }
}

function render() {
  const windowCount = countWindows(state.entries);

  if (windowCount <= 1) {
    state.showCurrentWindowOnly = false;
  }

  // Keep the keyboard cursor in visual (grouped) order rather than window/index order.
  const groups = groupByDomain(getVisibleEntries());
  state.visibleEntries = groups.flatMap(group => group.entries);
  state.cursor = Math.min(state.cursor, state.visibleEntries.length - 1);

  const duplicateCount = getDuplicateGroups(state.entries).reduce((sum, group) => sum + group.length - 1, 0);

  elements.summary.textContent = [
    formatCount(state.entries.length, "tab"),
    formatCount(windowCount, "window"),
    formatCount(countDomains(state.entries), "domain")
  ].join(" / ");

  updateCurrentWindowButton(windowCount);
  elements.duplicatesButton.disabled = duplicateCount === 0;
  elements.duplicatesButton.textContent = duplicateCount ? `Duplicates ${duplicateCount}` : "No duplicates";
  updateCloseAllButton();
  renderTabList(groups);
}

function updateCurrentWindowButton(windowCount) {
  const canFilterByWindow = windowCount > 1;

  elements.currentWindowButton.disabled = !canFilterByWindow;
  elements.currentWindowButton.setAttribute("aria-pressed", String(canFilterByWindow && state.showCurrentWindowOnly));
  elements.currentWindowButton.textContent = canFilterByWindow
    ? state.showCurrentWindowOnly ? "All windows" : "Current window"
    : "1 window";
  elements.currentWindowButton.title = canFilterByWindow
    ? "Toggle between the current window and all windows"
    : "Only one Chrome window is open";
}

function updateCloseAllButton() {
  const button = elements.closeAllButton;
  const count = getCloseAllTargets().length;

  if (!count) {
    disarmCloseAll();
  }

  button.disabled = count === 0;
  button.classList.toggle("is-armed", state.closeAllArmed);

  if (!count) {
    button.textContent = "Close all";
    button.title = "No tabs to close";
  } else if (state.closeAllArmed) {
    button.textContent = `Confirm ${count}`;
    button.title = `Click again to close ${formatCount(count, "tab")}`;
  } else if (isFiltered()) {
    button.textContent = `Close ${count} shown`;
    button.title = "Close only the tabs currently listed";
  } else {
    button.textContent = `Close all ${count}`;
    button.title = "Close all open tabs across all Chrome windows";
  }
}

function renderTabList(groups) {
  const { scrollTop } = elements.tabsRoot;

  state.renderedGroups = new Map();

  if (!state.visibleEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.terms.length
      ? "No matching tabs."
      : state.showCurrentWindowOnly ? "No tabs in the current window." : "No open tabs found.";
    elements.tabsRoot.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const cursorEntry = state.visibleEntries[state.cursor];

  groups.forEach(group => {
    const groupNode = elements.groupTemplate.content.firstElementChild.cloneNode(true);
    const list = groupNode.querySelector(".tab-list");
    const countLabel = getGroupCountLabel(group.entries);

    state.renderedGroups.set(group.key, group);
    groupNode.dataset.groupKey = group.key;
    groupNode.querySelector("h2").textContent = group.heading;
    groupNode.querySelector(".group-count").textContent = countLabel;
    groupNode.querySelector(".group-close-button").title = `Close ${countLabel} from ${group.heading}`;

    group.entries.forEach(entry => {
      list.append(createTabRow(entry, entry === cursorEntry));
    });

    fragment.append(groupNode);
  });

  elements.tabsRoot.replaceChildren(fragment);
  elements.tabsRoot.scrollTop = scrollTop;
}

function createTabRow(entry, isCursor) {
  const { tab } = entry;
  const row = elements.tabTemplate.content.firstElementChild.cloneNode(true);
  const faviconWrap = row.querySelector(".favicon-wrap");
  const pinButton = row.querySelector(".pin-button");
  const muteButton = row.querySelector(".mute-button");
  const title = tab.title || "Untitled tab";
  const isMuted = Boolean(tab.mutedInfo?.muted);
  const faviconSrc = getFaviconSrc(entry);

  row.dataset.tabId = String(tab.id);
  row.classList.toggle("is-active", tab.active);
  row.classList.toggle("is-cursor", isCursor);
  row.querySelector(".tab-main").title = `Go to ${title}`;
  row.querySelector(".tab-title").textContent = title;
  row.querySelector(".tab-url").textContent = entry.readableUrl;
  row.querySelector(".favicon-fallback").textContent = entry.fallbackLetter;

  if (faviconSrc) {
    row.querySelector(".favicon").src = faviconSrc;
  } else {
    faviconWrap.classList.add("is-empty");
  }

  pinButton.textContent = tab.pinned ? "Unpin" : "Pin";
  pinButton.classList.toggle("is-on", tab.pinned);
  muteButton.textContent = isMuted ? "Unmute" : "Mute";
  muteButton.classList.toggle("is-on", isMuted);

  return row;
}

async function focusTab(entry) {
  const { tab } = entry;

  try {
    const updatedTab = await chrome.tabs.update(tab.id, { active: true });

    try {
      await chrome.windows.update(updatedTab?.windowId ?? tab.windowId, { focused: true });
    } catch {
      // Activating the tab is the main action; window focus can fail in some Chrome contexts.
    }

    window.close();
  } catch (error) {
    setStatus(`Could not focus tab: ${error.message}`, true);
  }
}

async function closeTab(entry) {
  try {
    await chrome.tabs.remove(entry.tab.id);
    removeEntries([entry]);
    render();
  } catch (error) {
    setStatus(`Could not close tab: ${error.message}`, true);
  }
}

async function togglePinned(entry) {
  try {
    await chrome.tabs.update(entry.tab.id, { pinned: !entry.tab.pinned });
    // Pinning moves the tab to the front of its window and shifts every other index, so reload.
    await loadTabs();
  } catch (error) {
    setStatus(`Could not update pin state: ${error.message}`, true);
  }
}

async function toggleMuted(entry) {
  try {
    const updated = await chrome.tabs.update(entry.tab.id, { muted: !entry.tab.mutedInfo?.muted });
    replaceEntry(updated);
    render();
  } catch (error) {
    setStatus(`Could not update sound state: ${error.message}`, true);
  }
}

async function closeDuplicateTabs() {
  const targets = getDuplicateGroups(state.entries).flatMap(group => {
    const keeper = getDuplicateKeeper(group);
    return group.filter(entry => entry !== keeper);
  });

  if (!targets.length) {
    render();
    return;
  }

  try {
    await chrome.tabs.remove(targets.map(entry => entry.tab.id));
    removeEntries(targets);
    setStatus(`Closed ${formatCount(targets.length, "duplicate tab")}.`);
    render();
  } catch (error) {
    await loadTabs();
    setStatus(`Could not close duplicates: ${error.message}`, true);
  }
}

async function closeAllTabs() {
  const targets = getCloseAllTargets();
  const label = isFiltered() ? "listed tab" : "tab";

  if (!targets.length) {
    render();
    return;
  }

  try {
    await chrome.tabs.remove(targets.map(entry => entry.tab.id));
    removeEntries(targets);
    setStatus(`Closed ${formatCount(targets.length, label)}.`);
    render();
  } catch (error) {
    await loadTabs();
    setStatus(`Could not close tabs: ${error.message}`, true);
  }
}

async function closeTabGroup(group) {
  const targets = [...group.entries];

  if (!targets.length) {
    render();
    return;
  }

  try {
    await chrome.tabs.remove(targets.map(entry => entry.tab.id));
    removeEntries(targets);
    setStatus(`Closed ${formatCount(targets.length, "tab")} from ${group.heading}.`);
    render();
  } catch (error) {
    await loadTabs();
    setStatus(`Could not close ${group.heading}: ${error.message}`, true);
  }
}

// Everything derived from a tab is computed once here, so re-rendering while the user
// types never re-parses URLs.
function createEntry(tab) {
  const url = tab.url || tab.pendingUrl || "";
  const readableUrl = getReadableUrl(url);

  return {
    tab,
    url,
    readableUrl,
    fallbackLetter: (tab.title || readableUrl).trim().charAt(0).toUpperCase() || "?",
    domain: getDomainInfo(url),
    duplicateKey: normalizeUrl(url),
    searchText: `${tab.title || ""} ${url}`.toLowerCase()
  };
}

function setEntries(tabs) {
  state.entries = tabs.map(createEntry).sort(compareEntries);
}

function removeEntries(entries) {
  const removedIds = new Set(entries.map(entry => entry.tab.id));
  state.entries = state.entries.filter(entry => !removedIds.has(entry.tab.id));
}

function replaceEntry(tab) {
  state.entries = state.entries
    .map(entry => entry.tab.id === tab.id ? createEntry(tab) : entry)
    .sort(compareEntries);
}

function findEntry(tabId) {
  return state.entries.find(entry => entry.tab.id === tabId);
}

function isFiltered() {
  return state.terms.length > 0 || state.showCurrentWindowOnly;
}

function getCloseAllTargets() {
  return isFiltered() ? state.visibleEntries : state.entries;
}

function getVisibleEntries() {
  return state.entries.filter(entry => {
    if (state.showCurrentWindowOnly && entry.tab.windowId !== state.currentWindowId) {
      return false;
    }

    return state.terms.every(term => entry.searchText.includes(term));
  });
}

// Chrome's own favicon cache serves http(s) icons locally, so the popup never hits the
// network for icons and discarded tabs still show theirs.
function getFaviconSrc(entry) {
  if (/^https?:\/\//.test(entry.url)) {
    return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(entry.url)}&size=32`);
  }

  return entry.tab.favIconUrl || "";
}

function groupByDomain(entries) {
  const groups = new Map();

  entries.forEach(entry => {
    const { key, label, sortLabel } = entry.domain;

    if (!groups.has(key)) {
      groups.set(key, { key, heading: label, sortLabel, entries: [] });
    }

    groups.get(key).entries.push(entry);
  });

  return [...groups.values()]
    .sort((a, b) => a.sortLabel.localeCompare(b.sortLabel) || a.key.localeCompare(b.key));
}

function getGroupCountLabel(entries) {
  const tabCount = formatCount(entries.length, "tab");
  const windowCount = countWindows(entries);
  return windowCount > 1 ? `${tabCount} / ${formatCount(windowCount, "window")}` : tabCount;
}

function getDuplicateGroups(entries) {
  const byUrl = new Map();

  entries.forEach(entry => {
    if (!entry.duplicateKey) {
      return;
    }

    if (!byUrl.has(entry.duplicateKey)) {
      byUrl.set(entry.duplicateKey, []);
    }

    byUrl.get(entry.duplicateKey).push(entry);
  });

  return [...byUrl.values()].filter(group => group.length > 1);
}

function getDuplicateKeeper(group) {
  return [...group].sort((a, b) => getKeepScore(b) - getKeepScore(a) || compareEntries(a, b))[0];
}

function getKeepScore({ tab }) {
  return Number(tab.active) * 4 + Number(tab.pinned) * 2 + Number(tab.windowId === state.currentWindowId);
}

function compareEntries(a, b) {
  return compareTabs(a.tab, b.tab);
}

function compareTabs(a, b) {
  return a.windowId - b.windowId || Number(b.pinned) - Number(a.pinned) || a.index - b.index;
}

function countWindows(entries) {
  return new Set(entries.map(entry => entry.tab.windowId)).size;
}

function countDomains(entries) {
  return new Set(entries.map(entry => entry.domain.key)).size;
}

function getDomainInfo(url) {
  if (!url) {
    return createDomainInfo("none", "No domain", "zzzz no domain");
  }

  if (isChromeNewTabUrl(url)) {
    return createDomainInfo("chrome:newtab", "chrome://newtab", "chrome://newtab");
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol === "blob:") {
      return getDomainInfo(parsed.pathname);
    }

    if (parsed.protocol === "chrome-extension:") {
      return createDomainInfo("chrome-extension", "Extension pages", "zz chrome extension");
    }

    if (parsed.protocol === "chrome:") {
      const page = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
      const label = page ? `chrome://${page}` : "Chrome pages";
      return createDomainInfo(`chrome:${page || "pages"}`, label, label);
    }

    if (parsed.protocol === "file:") {
      return createDomainInfo("file", "Local files", "zz local files");
    }

    if (parsed.hostname) {
      const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
      return createDomainInfo(`host:${hostname}`, hostname, hostname);
    }

    if (parsed.protocol === "about:") {
      const label = parsed.pathname ? `about:${parsed.pathname}` : "About pages";
      return createDomainInfo(`about:${parsed.pathname || "pages"}`, label, label);
    }

    if (parsed.protocol === "data:") {
      return createDomainInfo("data", "Data URL pages", "zz data urls");
    }

    const protocol = parsed.protocol.replace(/:$/, "");
    const label = protocol ? `${protocol} pages` : "No domain";
    return createDomainInfo(`protocol:${protocol || "none"}`, label, `zz ${label}`);
  } catch {
    return createDomainInfo("other", "Other pages", "zz other pages");
  }
}

function createDomainInfo(key, label, sortLabel) {
  return { key, label, sortLabel };
}

function normalizeUrl(url) {
  if (!url || url.startsWith("chrome-extension://")) {
    return "";
  }

  if (isChromeNewTabUrl(url)) {
    return "chrome://newtab/";
  }

  if (url.startsWith("chrome://")) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isChromeNewTabUrl(url) {
  return url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}

function getReadableUrl(url) {
  if (!url) {
    return "No URL";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") + parsed.pathname;
  } catch {
    return url;
  }
}

function setStatus(message, isError = false) {
  elements.status.hidden = false;
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", isError);
}

function clearStatus() {
  elements.status.hidden = true;
  elements.status.textContent = "";
  elements.status.classList.remove("is-error");
}

function formatCount(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
