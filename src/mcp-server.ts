// src/mcp-server.ts — Browser MCP Server
// Exposes browser control tools via the Model Context Protocol (stdio transport).
// Connects to the relay's named pipe as a CLIENT (multiple instances can coexist).
// The relay (spawned by Chrome) acts as the pipe server and routes requests/responses.

import * as net from 'net';
import { v4 as uuid } from 'uuid';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\browser-mcp-bridge'
  : '/tmp/browser-mcp-bridge.sock';

// --- Bridge: Named pipe client connecting to relay ---

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ExtensionBridge {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private connected = false;

  /** Connect to the relay's named pipe server. */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve) => {
      this.socket = net.connect(PIPE_PATH);

      this.socket.on('connect', () => {
        this.connected = true;
        process.stderr.write('[BrowserMCP] Connected to relay pipe\n');
        resolve();
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString('utf-8');
        this.processBuffer();
      });

      this.socket.on('close', () => {
        process.stderr.write('[BrowserMCP] Relay pipe disconnected\n');
        this.connected = false;
        this.socket = null;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Relay disconnected'));
        }
        this.pending.clear();
      });

      this.socket.on('error', (err) => {
        this.connected = false;
        this.socket = null;
        process.stderr.write(`[BrowserMCP] Pipe connection error: ${err.message}\n`);
        // Resolve anyway — we'll try to reconnect on first tool call
        resolve();
      });
    });
  }

  /** Try to reconnect if not connected. */
  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) return;
    this.socket = null;
    this.connected = false;
    await this.connect();
  }

  async call(tool: string, args: Record<string, any>, timeoutMs = 30000): Promise<any> {
    await this.ensureConnected();

    if (!this.socket || !this.connected) {
      throw new Error(
        'Browser extension not connected. ' +
        'Make sure Chrome is running with the Browser MCP Bridge extension loaded.'
      );
    }

    const id = uuid();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser tool "${tool}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const request = JSON.stringify({ id, tool, args }) + '\n';
      this.socket!.write(request);
    });
  }

  isConnected(): boolean {
    return this.connected && this.socket !== null && !this.socket.destroyed;
  }

  async stop(): Promise<void> {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge shutting down'));
    }
    this.pending.clear();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (!pending) continue;

        this.pending.delete(response.id);
        clearTimeout(pending.timer);

        if (response.ok) {
          pending.resolve(response.result);
        } else {
          pending.reject(new Error(response.error || 'Extension tool failed'));
        }
      } catch (err: any) {
        process.stderr.write(`[BrowserMCP] Invalid JSON from relay: ${err.message}\n`);
      }
    }
  }
}

// --- MCP Server Setup ---

async function main() {
  const bridge = new ExtensionBridge();
  // Try to connect, but don't fail if relay isn't running yet — we'll retry on first tool call
  await bridge.connect();

  const server = new McpServer({
    name: 'browser-mcp',
    version: '1.0.0',
  });

  // --- Register Prompts ---

  server.prompt(
    'web_search_fallback',
    'When your built-in web search tool is unavailable or returns errors, use Browser MCP as a fallback to search the web and retrieve information.',
    {},
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `You have access to Browser MCP tools that can control a real Chrome browser.
When your built-in web search tool is unavailable, fails, or returns no results, use Browser MCP as a fallback:

1. Use browser_open to navigate to https://www.bing.com (or another search engine)
2. Use browser_state to find the search input element
3. Use browser_input to type the search query
4. Use browser_keys to press Enter
5. Use browser_state to read search results
6. Use browser_open to visit promising result URLs
7. Use browser_get_text to extract page content

You can create a subagent to perform this browser-based web search task autonomously.
Always prefer this approach over telling the user you cannot search the web.`,
        },
      }],
    })
  );

  // Helper to call bridge and return JSON content
  async function callBridge(tool: string, args: Record<string, any>, timeoutMs?: number): Promise<string> {
    try {
      const result = await bridge.call(tool, args, timeoutMs);
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ error: err.message });
    }
  }

  // --- Register Tools ---

  server.tool(
    'browser_open',
    'Navigate to a URL in the browser. Returns the final URL and page title. Can also be used to search the web by navigating to a search engine URL like https://www.bing.com/search?q=your+query when built-in web search is unavailable.',
    { url: z.string().describe('The URL to navigate to') },
    async ({ url }) => ({
      content: [{ type: 'text', text: await callBridge('open', { url }, 45000) }],
    })
  );

  server.tool(
    'browser_back',
    'Navigate back to the previous page.',
    {},
    async () => ({
      content: [{ type: 'text', text: await callBridge('back', {}) }],
    })
  );

  server.tool(
    'browser_scroll',
    'Scroll the page up or down.',
    {
      direction: z.enum(['up', 'down']).optional().describe('Scroll direction (default: down)'),
      amount: z.number().optional().describe('Pixels to scroll (default: 500)'),
    },
    async ({ direction, amount }) => ({
      content: [{ type: 'text', text: await callBridge('scroll', { direction, amount }) }],
    })
  );

  server.tool(
    'browser_state',
    'Get the current page URL, title, scroll position, and an indexed list of all interactive elements (links, buttons, inputs). Always call this after navigation to get fresh element indices.',
    {
      tabId: z.number().optional().describe('Target tab ID (optional, defaults to last opened tab)'),
    },
    async ({ tabId }) => ({
      content: [{ type: 'text', text: await callBridge('state', { tabId }) }],
    })
  );

  server.tool(
    'browser_screenshot',
    'Take a screenshot of the current visible page. Returns a base64 PNG data URL.',
    {},
    async () => ({
      content: [{ type: 'text', text: await callBridge('screenshot', {}) }],
    })
  );

  server.tool(
    'browser_click',
    'Click an interactive element by its index (from browser_state output).',
    {
      index: z.number().describe('Element index from browser_state'),
    },
    async ({ index }) => ({
      content: [{ type: 'text', text: await callBridge('click', { index }) }],
    })
  );

  server.tool(
    'browser_type',
    'Type text into the currently focused element. Use after clicking an input.',
    {
      text: z.string().describe('Text to type'),
    },
    async ({ text }) => ({
      content: [{ type: 'text', text: await callBridge('type', { text }) }],
    })
  );

  server.tool(
    'browser_input',
    'Click an element by index, then type text into it. Use for filling in search boxes, forms, etc.',
    {
      index: z.number().describe('Element index from browser_state'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing value first (default: true)'),
    },
    async ({ index, text, clear }) => ({
      content: [{ type: 'text', text: await callBridge('input', { index, text, clear: clear !== false }) }],
    })
  );

  server.tool(
    'browser_keys',
    'Send keyboard keys to the focused element (e.g. "Enter", "Tab", "Escape", "Ctrl+A").',
    {
      keys: z.string().describe('Key or key combo to press (e.g. "Enter", "Ctrl+A")'),
    },
    async ({ keys }) => ({
      content: [{ type: 'text', text: await callBridge('keys', { keys }) }],
    })
  );

  server.tool(
    'browser_select',
    'Select a dropdown option by element index and option text.',
    {
      index: z.number().describe('Element index of the <select> element'),
      option: z.string().describe('Text of the option to select'),
    },
    async ({ index, option }) => ({
      content: [{ type: 'text', text: await callBridge('select', { index, option }) }],
    })
  );

  server.tool(
    'browser_eval',
    'Execute JavaScript in the current page and return the result.',
    {
      expression: z.string().describe('JavaScript expression to evaluate'),
    },
    async ({ expression }) => ({
      content: [{ type: 'text', text: await callBridge('eval', { expression }) }],
    })
  );

  server.tool(
    'browser_get_text',
    'Get text content from the page. If index is provided, returns text of that element. Otherwise returns full page text (cleaned, up to 15000 chars).',
    {
      index: z.number().optional().describe('Element index (optional, omit for full page text)'),
    },
    async ({ index }) => ({
      content: [{ type: 'text', text: await callBridge('get_text', index !== undefined ? { index } : {}) }],
    })
  );

  server.tool(
    'browser_get_html',
    'Get HTML content by element index, CSS selector, or full body.',
    {
      index: z.number().optional().describe('Element index (optional)'),
      selector: z.string().optional().describe('CSS selector (optional)'),
    },
    async ({ index, selector }) => ({
      content: [{ type: 'text', text: await callBridge('get_html', { index, selector }) }],
    })
  );

  server.tool(
    'browser_wait',
    'Wait for a CSS selector or text to appear on the page.',
    {
      selector: z.string().optional().describe('CSS selector to wait for'),
      text: z.string().optional().describe('Text to wait for'),
      timeoutMs: z.number().optional().describe('Timeout in ms (default: 10000)'),
    },
    async ({ selector, text, timeoutMs }) => ({
      content: [{ type: 'text', text: await callBridge('wait', { selector, text, timeoutMs }) }],
    })
  );

  server.tool(
    'browser_close',
    'Close a browser tab. Use all: true to close all managed tabs.',
    {
      tabId: z.number().optional().describe('Tab ID to close (optional, defaults to last opened)'),
      all: z.boolean().optional().describe('Close all managed tabs'),
    },
    async ({ tabId, all }) => ({
      content: [{ type: 'text', text: await callBridge('close', { tabId, all }) }],
    })
  );

  server.tool(
    'browser_sessions',
    'List all open browser sessions/tabs managed by the extension.',
    {},
    async () => ({
      content: [{ type: 'text', text: await callBridge('sessions', {}) }],
    })
  );

  // --- Start MCP Server ---

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[BrowserMCP] MCP server started (stdio transport)\n');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await bridge.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[BrowserMCP] Fatal error: ${err.message}\n`);
  process.exit(1);
});
