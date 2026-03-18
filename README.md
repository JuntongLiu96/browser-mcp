# Browser MCP

An MCP server + Chrome extension that gives coding agents (Claude Code, etc.) full control over a real Chrome browser. Multiple Claude Code sessions can share the same browser simultaneously.

## Architecture

```
Claude Code #1 → MCP Server #1 ──┐
Claude Code #2 → MCP Server #2 ──┤  (pipe clients)
Claude Code #3 → MCP Server #3 ──┘
                                  │  Named pipe
                                  ▼
                    relay.js  (pipe server, spawned by Chrome)
                                  │  Chrome Native Messaging
                                  ▼
                    background.js  (Chrome Extension Service Worker)
                                  │  Chrome Extension APIs
                                  ▼
                              Web Pages
```

The relay acts as a named pipe server. Each Claude Code session spawns its own MCP server process, which connects to the relay as a pipe client. The relay multiplexes requests and routes responses back to the correct MCP client by matching request IDs.

## Prerequisites

- **Node.js** 18+ (must be in your system PATH)
- **Chrome** or **Edge** browser
- **Claude Code** (or any MCP-compatible client)

## Setup

### Step 1: Install dependencies and build

```bash
cd "C:\Browser MCP"
npm install
npm run build
```

This installs the MCP SDK and compiles the TypeScript server to `dist/mcp-server.js`.

### Step 2: Load the Chrome extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `extension/` folder inside this project (e.g. `C:\Browser MCP\extension`)
5. The extension **"Browser MCP Bridge"** will appear — copy the **Extension ID** shown underneath it
   - It looks like: `abcdefghijklmnopqrstuvwxyz012345`

### Step 3: Register the native messaging host

Run the installer script, passing your extension ID from the previous step:

```bash
node install.js <your-extension-id>
```

For example:

```bash
node install.js abcdefghijklmnopqrstuvwxyz012345
```

This does two things:
- Writes a native messaging host manifest file to `~/.browser-mcp/native-messaging/`
- Registers it in the Windows registry for both Chrome and Edge (or writes to the appropriate directory on macOS/Linux)

**Important:** If you ever reinstall the extension and get a new extension ID, re-run this command with the new ID.

### Step 4: Reload the extension

After running the installer, go back to `chrome://extensions` and click the **reload** button (circular arrow) on the Browser MCP Bridge extension. This allows the extension to pick up the newly registered native messaging host.

### Step 5: Add the MCP server to Claude Code

Option A — CLI command:

```bash
claude mcp add browser-mcp -- node "C:/Browser MCP/dist/mcp-server.js"
```

Option B — Add manually to your Claude Code config file (`.claude.json` in your project root, or the global `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["C:/Browser MCP/dist/mcp-server.js"]
    }
  }
}
```

### Step 6: Verify it works

Start a new Claude Code session and ask it something like:

> "Open https://example.com in the browser and get the page text"

You should see a new tab open in Chrome and Claude returning the page content.

## After Setup

Once setup is complete, you generally **don't need to do anything** when starting new sessions:

| Scenario | Action needed? |
|----------|----------------|
| Open a new Claude Code terminal | No — a new MCP server connects to the existing relay automatically |
| Open multiple Claude Code terminals | No — all sessions share the relay and can use the browser |
| Restart Chrome | No — the extension and relay auto-start |
| Restart your computer | No — Chrome loads the extension on start, Claude Code spawns the MCP server on demand |
| Reinstall / update the extension | Re-run `node install.js <new-extension-id>` if the ID changed, then reload |

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_open` | Navigate to a URL. Returns final URL and page title. |
| `browser_back` | Go back to the previous page. |
| `browser_scroll` | Scroll the page up or down by a pixel amount. |
| `browser_state` | Get page URL, title, scroll position, and indexed list of all interactive elements. **Call this after every navigation.** |
| `browser_screenshot` | Capture a PNG screenshot of the visible page. |
| `browser_click` | Click an element by its index from `browser_state`. |
| `browser_type` | Type text into the currently focused input element. |
| `browser_input` | Click an element by index then type into it (combined click + type). |
| `browser_keys` | Send keyboard keys (e.g. `Enter`, `Tab`, `Ctrl+A`). |
| `browser_select` | Select a dropdown `<select>` option by index and option text. |
| `browser_eval` | Execute JavaScript in the page and return the result. |
| `browser_get_text` | Get text content of an element (by index) or the full page. |
| `browser_get_html` | Get HTML content by element index, CSS selector, or full body. |
| `browser_wait` | Wait for a CSS selector or text to appear on the page. |
| `browser_close` | Close a tab (or all managed tabs with `all: true`). |
| `browser_sessions` | List all open tabs managed by the extension. |

## Usage Patterns

### Web search

```
1. browser_open    → navigate to https://www.bing.com
2. browser_state   → find the search input element index
3. browser_input   → type the search query into the input
4. browser_keys    → press Enter to submit
5. browser_state   → read the search result links and snippets
6. browser_open    → navigate to a promising result URL
7. browser_get_text → extract the page content
```

### Read a web page

```
1. browser_open    → navigate to the URL
2. browser_get_text → extract readable text content
```

### Fill out a form

```
1. browser_open    → navigate to the form page
2. browser_state   → get element indices for all form fields
3. browser_input   → fill each field by its index
4. browser_click   → click the submit button
```

## How It Works

1. **Chrome Extension** (`extension/background.js`) — A Manifest V3 service worker that controls Chrome tabs using the Extensions API. It connects to a native messaging host on load and executes browser commands (open, click, type, etc.) received over that channel.

2. **Relay** (`relay/relay.js`) — A small Node.js process spawned by Chrome as a native messaging host. It creates a **named pipe server** (`\\.\pipe\browser-mcp-bridge` on Windows) and bridges between Chrome's native messaging protocol (length-prefixed JSON on stdin/stdout) and the named pipe (newline-delimited JSON). It tracks which pipe client sent each request and routes responses back correctly.

3. **MCP Server** (`dist/mcp-server.js`) — A Node.js process spawned by Claude Code for each session. It connects to the relay's named pipe as a **client**, registers 16 browser tools via the MCP protocol over stdio, and translates MCP tool calls into relay requests. Multiple MCP server instances can connect simultaneously.

4. **Request flow:** MCP Client → MCP Server → Named Pipe → Relay → Chrome Native Messaging → Extension → Chrome Browser → response flows back the same path.

## Troubleshooting

### "Browser extension not connected"

This means the MCP server couldn't connect to the relay's named pipe. Possible causes:

1. **Extension not loaded** — Go to `chrome://extensions` and verify "Browser MCP Bridge" is listed and enabled
2. **Native messaging host not registered** — Re-run `node install.js <extension-id>`
3. **Extension needs reload** — Click the reload button on the extension card in `chrome://extensions`
4. **Chrome not running** — The relay only exists while Chrome is running with the extension loaded

### Extension loads but tools don't work

- Click **"Inspect views: service worker"** on the extension card in `chrome://extensions` to open the console
- Look for `[BMCP-Bridge]` log messages to diagnose connection issues

### Native messaging errors

- Verify Node.js is in your system PATH: run `node --version` from a terminal
- On Windows, verify registry entries exist:
  - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser.mcp.relay`
  - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.browser.mcp.relay`
- Re-run `node install.js <extension-id>` to regenerate the manifest and registry entries

### Multiple Claude Code sessions

All sessions share the same browser. Tabs opened by one session are visible to others via `browser_sessions`. If two sessions try to interact with the same tab simultaneously, results may be unpredictable — each session should work with its own tabs.

## Project Structure

```
Browser MCP/
├── src/
│   └── mcp-server.ts       # MCP server (pipe client + tool definitions)
├── dist/
│   └── mcp-server.js       # Compiled server (this is what Claude Code runs)
├── extension/
│   ├── manifest.json        # Chrome MV3 extension manifest
│   ├── background.js        # Service worker — executes browser commands
│   └── content.js           # Fallback content extraction script
├── relay/
│   ├── relay.js             # Native messaging relay (pipe server + request router)
│   └── relay.bat            # Windows wrapper for relay.js
├── install.js               # One-time setup: registers native messaging host
├── package.json
└── tsconfig.json
```
