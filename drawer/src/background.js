// Service worker: take over PDF navigations and open our annotating viewer.
//
// Strategy: a declarativeNetRequest *dynamic* rule (not static) so the redirect
// target can include this extension's real ID via chrome.runtime.getURL().
// Only main_frame .pdf navigations are redirected — the viewer's own fetch of
// the PDF bytes is an xmlhttprequest/other resource type and is left untouched,
// so there is no redirect loop.

const PDF_REDIRECT_RULE_ID = 1;

async function registerPdfRedirectRule() {
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PDF_REDIRECT_RULE_ID],
      addRules: [
        {
          id: PDF_REDIRECT_RULE_ID,
          priority: 1,
          action: {
            type: "redirect",
            // \\0 = the whole matched URL (the original .pdf address).
            redirect: { regexSubstitution: viewerUrl + "?file=\\0" },
          },
          condition: {
            // file:// or http(s):// URLs that end in .pdf (optional query string).
            regexFilter: "^(file|https?)://.*\\.pdf(\\?.*)?$",
            resourceTypes: ["main_frame"],
          },
        },
      ],
    });
  } catch (err) {
    console.error("[pdf-drawer] failed to register redirect rule:", err);
  }
}

chrome.runtime.onInstalled.addListener(registerPdfRedirectRule);
chrome.runtime.onStartup.addListener(registerPdfRedirectRule);

// Clicking the toolbar icon opens the viewer's welcome screen (drag/pick a PDF).
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/viewer/viewer.html") });
});
