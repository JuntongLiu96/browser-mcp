// background.js — MV3 service worker for Browser MCP Bridge.
// Provides low-level browser primitives via native messaging.
// Coding agents compose these primitives to accomplish high-level tasks.

const HOST_NAME = 'com.browser.mcp.relay';

// Active tabs managed by the extension, keyed by tabId
const managedTabs = new Map();
let port = null;

// --- Native Messaging ---

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.error('[BMCP-Bridge] Failed to connect:', err);
    return;
  }

  port.onMessage.addListener((request) => {
    handleRequest(request).then(
      (result) => respond(request.id, true, result),
      (err) => respond(request.id, false, null, err.message || String(err)),
    );
  });

  port.onDisconnect.addListener(() => {
    console.warn('[BMCP-Bridge] Disconnected:', chrome.runtime.lastError?.message);
    port = null;
  });

  console.log('[BMCP-Bridge] Connected to native host');
}

/** Ensure native messaging connection is alive, reconnect if needed. */
function ensureConnected() {
  if (!port) {
    connect();
  }
}

function respond(id, ok, result, error) {
  ensureConnected();
  if (!port) return;
  try {
    port.postMessage(ok ? { id, ok, result } : { id, ok: false, error: error || 'Unknown error' });
  } catch (err) {
    console.error('[BMCP-Bridge] Send failed:', err);
  }
}

// --- Tool Dispatch ---

async function handleRequest(request) {
  const { tool, args = {} } = request;
  switch (tool) {
    case 'open':        return doOpen(args);
    case 'back':        return doBack(args);
    case 'scroll':      return doScroll(args);
    case 'state':       return doState(args);
    case 'screenshot':  return doScreenshot(args);
    case 'click':       return doClick(args);
    case 'type':        return doType(args);
    case 'input':       return doInput(args);
    case 'keys':        return doKeys(args);
    case 'select':      return doSelect(args);
    case 'eval':        return doEval(args);
    case 'get_text':    return doGetText(args);
    case 'get_html':    return doGetHtml(args);
    case 'wait':        return doWait(args);
    case 'close':       return doClose(args);
    case 'sessions':    return doSessions();
    default:            throw new Error(`Unknown tool: ${tool}`);
  }
}

// --- Helpers ---

/** Get the target tabId — uses args.tabId or the most recently opened managed tab. */
async function getTargetTabId(args) {
  if (args.tabId) return args.tabId;
  // Find last managed tab that still exists
  for (const [tabId] of [...managedTabs].reverse()) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      managedTabs.delete(tabId);
    }
  }
  throw new Error('No active browser session. Use "browser_open" to navigate to a URL first.');
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        setTimeout(resolve, 300);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Tool: open ---
async function doOpen(args) {
  const { url } = args;
  if (!url) throw new Error('url is required');

  const tab = await chrome.tabs.create({ url, active: false });
  managedTabs.set(tab.id, { url, createdAt: Date.now() });
  await waitForTabLoad(tab.id);

  const updatedTab = await chrome.tabs.get(tab.id);
  return { tabId: tab.id, url: updatedTab.url, title: updatedTab.title };
}

// --- Tool: back ---
async function doBack(args) {
  const tabId = await getTargetTabId(args);
  await chrome.tabs.goBack(tabId);
  await waitForTabLoad(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url, title: tab.title };
}

// --- Tool: scroll ---
async function doScroll(args) {
  const tabId = await getTargetTabId(args);
  const direction = args.direction || 'down';
  const amount = args.amount || 500;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (dir, px) => {
      const y = dir === 'up' ? -px : px;
      window.scrollBy(0, y);
      return {
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      };
    },
    args: [direction, amount],
  });
  return results[0]?.result || {};
}

// --- Tool: state ---
async function doState(args) {
  const tabId = await getTargetTabId(args);
  const tab = await chrome.tabs.get(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Build indexed list of interactive elements
      const interactiveSelectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]';
      const elements = document.querySelectorAll(interactiveSelectors);
      const items = [];
      let idx = 0;

      for (const el of elements) {
        // Skip hidden elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.textContent || '').trim().slice(0, 80);
        const type = el.getAttribute('type') || '';
        const role = el.getAttribute('role') || '';
        const href = el.getAttribute('href') || '';
        const name = el.getAttribute('name') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const value = el.value !== undefined ? String(el.value).slice(0, 40) : '';

        // Set a data attribute for later retrieval by index
        el.setAttribute('data-bmcp-idx', String(idx));

        let desc = `[${idx}] <${tag}`;
        if (type) desc += ` type="${type}"`;
        if (role) desc += ` role="${role}"`;
        if (name) desc += ` name="${name}"`;
        if (placeholder) desc += ` placeholder="${placeholder}"`;
        if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
        if (href) desc += ` href="${href.slice(0, 60)}"`;
        desc += '>';
        if (text) desc += ` ${text}`;
        if (value) desc += ` [value="${value}"]`;

        items.push(desc);
        idx++;
      }

      return {
        url: window.location.href,
        title: document.title,
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        elements: items,
      };
    },
  });
  return results[0]?.result || { url: tab.url, title: tab.title, elements: [] };
}

// --- Tool: screenshot ---
async function doScreenshot(args) {
  const tabId = await getTargetTabId(args);
  const tab = await chrome.tabs.get(tabId);

  // captureVisibleTab needs the tab's window
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { dataUrl };
}

// --- Tool: click ---
async function doClick(args) {
  const tabId = await getTargetTabId(args);
  const index = args.index;
  if (index === undefined) throw new Error('index is required');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idx) => {
      const el = document.querySelector(`[data-bmcp-idx="${idx}"]`);
      if (!el) return { error: `Element [${idx}] not found. Run "browser_state" to refresh indices.` };
      el.click();
      return { clicked: idx, tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 80) };
    },
    args: [index],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);

  // If click triggered navigation, wait for load
  await new Promise(r => setTimeout(r, 500));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') {
      await waitForTabLoad(tabId);
    }
  } catch {}

  return result;
}

// --- Tool: type ---
async function doType(args) {
  const tabId = await getTargetTabId(args);
  const { text } = args;
  if (!text) throw new Error('text is required');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (txt) => {
      const el = document.activeElement;
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
        return { error: 'No focused input element. Use "browser_click" or "browser_input" to focus an element first.' };
      }
      if (el.isContentEditable) {
        el.textContent = (el.textContent || '') + txt;
      } else {
        el.value = (el.value || '') + txt;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: txt, element: el.tagName.toLowerCase() };
    },
    args: [text],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result;
}

// --- Tool: input (click element then type) ---
async function doInput(args) {
  const tabId = await getTargetTabId(args);
  const { index, text, clear = true } = args;
  if (index === undefined) throw new Error('index is required');
  if (!text) throw new Error('text is required');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idx, txt, shouldClear) => {
      const el = document.querySelector(`[data-bmcp-idx="${idx}"]`);
      if (!el) return { error: `Element [${idx}] not found. Run "browser_state" to refresh indices.` };

      el.focus();
      el.click();

      if (el.isContentEditable) {
        if (shouldClear) el.textContent = '';
        el.textContent = (el.textContent || '') + txt;
      } else {
        if (shouldClear) el.value = '';
        el.value = (el.value || '') + txt;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { index: idx, typed: txt, tag: el.tagName.toLowerCase() };
    },
    args: [index, text, clear],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result;
}

// --- Tool: keys ---
async function doKeys(args) {
  const tabId = await getTargetTabId(args);
  const { keys } = args;
  if (!keys) throw new Error('keys is required (e.g. "Enter", "Tab", "Escape")');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (keyStr) => {
      const el = document.activeElement || document.body;
      // Support key combos like "Ctrl+Enter"
      const parts = keyStr.split('+').map(s => s.trim());
      const key = parts.pop();
      const ctrlKey = parts.includes('Ctrl') || parts.includes('Control');
      const shiftKey = parts.includes('Shift');
      const altKey = parts.includes('Alt');
      const metaKey = parts.includes('Meta') || parts.includes('Cmd');

      const opts = { key, code: `Key${key.toUpperCase()}`, ctrlKey, shiftKey, altKey, metaKey, bubbles: true };

      // Special key codes
      if (key === 'Enter') opts.code = 'Enter';
      else if (key === 'Tab') opts.code = 'Tab';
      else if (key === 'Escape') opts.code = 'Escape';
      else if (key === 'Backspace') opts.code = 'Backspace';
      else if (key === 'ArrowDown') opts.code = 'ArrowDown';
      else if (key === 'ArrowUp') opts.code = 'ArrowUp';

      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));

      // If Enter on a form, try submitting
      if (key === 'Enter' && el.form) {
        el.form.dispatchEvent(new Event('submit', { bubbles: true }));
      }

      return { keys: keyStr, target: el.tagName.toLowerCase() };
    },
    args: [keys],
  });

  // Wait in case keys triggered navigation
  await new Promise(r => setTimeout(r, 500));
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') await waitForTabLoad(tabId);
  } catch {}

  return results[0]?.result || {};
}

// --- Tool: select ---
async function doSelect(args) {
  const tabId = await getTargetTabId(args);
  const { index, option } = args;
  if (index === undefined) throw new Error('index is required');
  if (!option) throw new Error('option text is required');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idx, optText) => {
      const el = document.querySelector(`[data-bmcp-idx="${idx}"]`);
      if (!el) return { error: `Element [${idx}] not found.` };
      if (el.tagName !== 'SELECT') return { error: `Element [${idx}] is not a <select>.` };

      const options = Array.from(el.options);
      const match = options.find(o =>
        o.text.toLowerCase().includes(optText.toLowerCase()) ||
        o.value.toLowerCase().includes(optText.toLowerCase())
      );
      if (!match) return { error: `Option "${optText}" not found. Available: ${options.map(o => o.text).join(', ')}` };

      el.value = match.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: match.text, value: match.value };
    },
    args: [index, option],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result;
}

// --- Tool: eval ---
async function doEval(args) {
  const tabId = await getTargetTabId(args);
  const { expression } = args;
  if (!expression) throw new Error('expression is required');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expr) => {
      try {
        const result = eval(expr);
        return { value: typeof result === 'object' ? JSON.stringify(result) : String(result) };
      } catch (err) {
        return { error: err.message };
      }
    },
    args: [expression],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result;
}

// --- Tool: get_text ---
async function doGetText(args) {
  const tabId = await getTargetTabId(args);
  const index = args.index !== undefined ? args.index : null;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idx) => {
      if (idx !== null) {
        const el = document.querySelector(`[data-bmcp-idx="${idx}"]`);
        if (!el) return { error: `Element [${idx}] not found.` };
        return { text: (el.innerText || el.textContent || '').trim() };
      }
      // No index: return full page text (cleaned)
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, svg').forEach(e => e.remove());
      const text = (clone.innerText || '').replace(/\s+/g, ' ').trim();
      return { text: text.slice(0, 15000), truncated: text.length > 15000 };
    },
    args: [index],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result;
}

// --- Tool: get_html ---
async function doGetHtml(args) {
  const tabId = await getTargetTabId(args);
  const selector = args.selector || null;
  const index = args.index !== undefined ? args.index : null;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, idx) => {
      let el;
      if (idx !== null) {
        el = document.querySelector(`[data-bmcp-idx="${idx}"]`);
      } else if (sel) {
        el = document.querySelector(sel);
      } else {
        el = document.body;
      }
      if (!el) return { error: `Element not found.` };
      const html = el.innerHTML.slice(0, 15000);
      return { html, truncated: el.innerHTML.length > 15000 };
    },
    args: [selector, index],
  });

  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result;
}

// --- Tool: wait ---
async function doWait(args) {
  const tabId = await getTargetTabId(args);
  const selector = args.selector || null;
  const text = args.text || null;
  const timeoutMs = args.timeoutMs || 10000;

  if (!selector && !text) throw new Error('Either "selector" or "text" is required');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (sel, txt, timeout) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (sel && document.querySelector(sel)) return { found: true, type: 'selector', match: sel };
        if (txt && document.body.innerText.includes(txt)) return { found: true, type: 'text', match: txt };
        await new Promise(r => setTimeout(r, 200));
      }
      return { found: false, type: sel ? 'selector' : 'text', match: sel || txt };
    },
    args: [selector, text, timeoutMs],
  });

  return results[0]?.result || { found: false };
}

// --- Tool: close ---
async function doClose(args) {
  if (args.all) {
    const ids = [...managedTabs.keys()];
    for (const id of ids) {
      try { await chrome.tabs.remove(id); } catch {}
      managedTabs.delete(id);
    }
    return { closed: ids.length };
  }

  const tabId = await getTargetTabId(args);
  try { await chrome.tabs.remove(tabId); } catch {}
  managedTabs.delete(tabId);
  return { closed: tabId };
}

// --- Tool: sessions ---
async function doSessions() {
  const sessions = [];
  for (const [tabId, info] of managedTabs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      sessions.push({ tabId, url: tab.url, title: tab.title, status: tab.status });
    } catch {
      managedTabs.delete(tabId);
    }
  }
  return { sessions };
}

// --- Clean up closed tabs ---
chrome.tabs.onRemoved.addListener((tabId) => {
  managedTabs.delete(tabId);
});

// --- Start ---
connect();
