#!/usr/bin/env node
// relay.js — Native Messaging host: bridges Chrome Extension ↔ MCP Server(s).
// Chrome spawns one instance per connectNative() call.
// Acts as a named pipe SERVER so multiple MCP server instances can connect as clients.
// Routes responses back to the correct MCP client by matching request IDs.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// --- Logging (file-based, since Chrome native messaging stderr is not visible) ---
const logFile = path.join(os.tmpdir(), 'browser-mcp-relay.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] [Relay] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(logFile, line); } catch {}
}

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
  cleanup();
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err}`);
});

log(`Starting... pid=${process.pid}`);

const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\browser-mcp-bridge'
  : '/tmp/browser-mcp-bridge.sock';

// Map of request ID → socket that sent it, for routing responses back
const requestOrigin = new Map();
// All connected MCP server sockets
const clients = new Set();
let inputBuffer = Buffer.alloc(0);
let pipeServer = null;

// --- Exit handler ---
function cleanup() {
  for (const client of clients) {
    if (!client.destroyed) client.destroy();
  }
  clients.clear();
  if (pipeServer) {
    pipeServer.close();
    pipeServer = null;
  }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGHUP', cleanup);

// --- Chrome Native Messaging: read from stdin ---
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on('end', () => { log('stdin ended'); cleanup(); });
process.stdin.on('close', () => { log('stdin closed'); cleanup(); });
process.stdin.on('error', (e) => { log(`stdin error: ${e.message}`); cleanup(); });

function drainInput() {
  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) break;
    const json = inputBuffer.slice(4, 4 + msgLen).toString('utf-8');
    inputBuffer = inputBuffer.slice(4 + msgLen);
    routeResponseToClient(json);
  }
}

// --- Chrome Native Messaging: write to stdout ---
function writeToChrome(obj) {
  try {
    const json = JSON.stringify(obj);
    const len = Buffer.byteLength(json, 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(len, 0);
    process.stdout.write(header);
    process.stdout.write(json, 'utf-8');
  } catch {
    cleanup();
  }
}

// --- Route extension response back to the MCP client that sent the request ---
function routeResponseToClient(json) {
  try {
    const response = JSON.parse(json);
    const origin = requestOrigin.get(response.id);
    if (origin && !origin.destroyed) {
      origin.write(json + '\n');
      requestOrigin.delete(response.id);
    }
  } catch {}
}

// --- Forward request from MCP client to Chrome extension ---
function forwardToChrome(json, sourceSocket) {
  try {
    const request = JSON.parse(json);
    // Track which socket sent this request so we can route the response back
    if (request.id) {
      requestOrigin.set(request.id, sourceSocket);
    }
    writeToChrome(request);
  } catch {}
}

// --- Named pipe server: accepts connections from MCP server instances ---
function startPipeServer() {
  // On Unix, remove stale socket file
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(PIPE_PATH); } catch {}
  }

  pipeServer = net.createServer((socket) => {
    clients.add(socket);

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          forwardToChrome(line, socket);
        }
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      // Clean up any pending requests from this socket
      for (const [id, origin] of requestOrigin) {
        if (origin === socket) requestOrigin.delete(id);
      }
    });

    socket.on('error', () => {
      clients.delete(socket);
    });
  });

  pipeServer.on('error', (err) => {
    log(`Pipe server error: ${err.code} - ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      // Another relay is already running — exit gracefully
      log('EADDRINUSE — another relay is running, exiting');
      process.exit(0);
    }
  });

  pipeServer.listen(PIPE_PATH, () => {
    log(`Pipe server listening on ${PIPE_PATH}`);
  });
}

// --- Start ---
startPipeServer();
