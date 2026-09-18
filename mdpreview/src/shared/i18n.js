export function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// Fills elements marked with data-i18n / data-i18n-title / data-i18n-placeholder.
export function localize(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  document.documentElement.lang = chrome.i18n.getUILanguage();
}
