// content.js — Injected into pages for content extraction.
// This is a fallback; most extraction happens via chrome.scripting.executeScript in background.js.

(function extractContent() {
  const MAX_LENGTH = 15000;
  const title = document.title || '';
  const url = window.location.href;

  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
  const raw = (clone.innerText || '').replace(/\s+/g, ' ').trim();
  const content = raw.slice(0, MAX_LENGTH);

  return { title, url, content, truncated: raw.length > MAX_LENGTH };
})();
