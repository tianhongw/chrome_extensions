import DOMPurify from 'dompurify';

// DOMPurify's default URI allow-list plus file:, so local documents can link
// to (and embed images from) sibling files.
const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// Sanitizes rendered Markdown HTML and returns it as a DocumentFragment.
// <style> is dropped so documents cannot restyle the viewer UI around them.
//
// The clean HTML *string* is re-parsed in an inert <template> instead of using
// DOMPurify's RETURN_DOM_FRAGMENT: in a content script, the nodes DOMPurify
// parses carry main-world event handlers (e.g. onerror) that removing the
// attribute from the isolated world does not unregister, so adopting those
// nodes into the page would still run the handlers.
export function sanitize(html) {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style'],
    ALLOWED_URI_REGEXP,
  });
  return template.content;
}
