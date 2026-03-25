#!/usr/bin/env node
// install.js — Installs the Chrome/Edge Native Messaging host manifest for Browser MCP.
// Usage: node install.js <chrome-extension-id>

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOST_NAME = 'com.browser.mcp.relay';
const SOCK_PATH = '/tmp/browser-mcp-bridge.sock';

function getAppDataDir() {
  return path.join(os.homedir(), '.browser-mcp');
}

/** Kill stale relay processes and remove leftover socket file. */
function cleanupStaleRelay() {
  console.log('Cleaning up stale relay processes and socket...');

  if (process.platform === 'win32') {
    try {
      const out = execSync('wmic process where "CommandLine like \'%relay.js%\'" get ProcessId /format:list', { encoding: 'utf-8' });
      const pids = out.match(/ProcessId=(\d+)/g);
      if (pids) {
        for (const m of pids) {
          const pid = m.split('=')[1];
          try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' }); } catch {}
        }
      }
    } catch {}
  } else {
    try {
      const out = execSync("pgrep -f 'relay\\.js' 2>/dev/null", { encoding: 'utf-8' }).trim();
      if (out) {
        for (const pid of out.split('\n')) {
          if (pid && pid !== String(process.pid)) {
            try { process.kill(Number(pid), 'SIGTERM'); } catch {}
          }
        }
        console.log(`  Killed stale relay process(es): ${out.replace(/\n/g, ', ')}`);
      }
    } catch {}

    // Remove stale socket file
    try {
      fs.unlinkSync(SOCK_PATH);
      console.log(`  Removed stale socket: ${SOCK_PATH}`);
    } catch {}
  }

  console.log('  Cleanup done.');
}

function main() {
  const extensionId = process.argv[2];
  if (!extensionId) {
    console.error('Usage: node install.js <chrome-extension-id>');
    console.error('');
    console.error('To find your extension ID:');
    console.error('  1. Load the extension/ folder as an unpacked extension in Chrome');
    console.error('  2. Go to chrome://extensions');
    console.error('  3. Copy the extension ID (e.g. "abcdefghijklmnopqrstuvwxyz123456")');
    process.exit(1);
  }

  // Clean up stale relay processes/socket before installing
  cleanupStaleRelay();

  const relayDir = path.join(__dirname, 'relay');
  const relayScript = path.join(relayDir, 'relay.js');

  if (!fs.existsSync(relayScript)) {
    console.error(`Error: relay.js not found at ${relayScript}`);
    process.exit(1);
  }

  // Create wrapper script
  let wrapperPath;
  if (process.platform === 'win32') {
    wrapperPath = path.join(relayDir, 'relay.bat');
    const content = `@echo off\r\nnode "${relayScript}"\r\n`;
    fs.writeFileSync(wrapperPath, content, 'utf-8');
    console.log(`Created wrapper: ${wrapperPath}`);
  } else {
    wrapperPath = path.join(relayDir, 'relay.sh');
    // Resolve absolute path to node — Chrome's native messaging uses a minimal PATH
    // that doesn't include Homebrew (/opt/homebrew/bin) or nvm/fnm directories
    let nodePath;
    try {
      nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
    } catch {
      nodePath = 'node';
      console.warn('Warning: Could not resolve absolute path to node. Native messaging may fail if node is not in the default PATH.');
    }
    const content = `#!/bin/sh\nexec "${nodePath}" "${relayScript}"\n`;
    fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
    console.log(`Created wrapper: ${wrapperPath}`);
  }

  const manifest = {
    name: HOST_NAME,
    description: 'Browser MCP native messaging relay',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  if (process.platform === 'win32') {
    installWindows(manifest);
  } else if (process.platform === 'darwin') {
    installMacOS(manifest);
  } else {
    installLinux(manifest);
  }

  // Save extension ID for future reference
  const appDataDir = getAppDataDir();
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.writeFileSync(path.join(appDataDir, 'extension-id.txt'), extensionId, 'utf-8');

  console.log('');
  console.log('Installation complete!');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Make sure the Browser MCP Bridge extension is loaded in Chrome');
  console.log('  2. Add the MCP server to your Claude Code settings:');
  console.log('');
  console.log('     claude mcp add browser-mcp -- node "' + path.join(__dirname, 'dist', 'mcp-server.js') + '"');
  console.log('');
  console.log('  Or add to .claude.json:');
  console.log('     {');
  console.log('       "mcpServers": {');
  console.log('         "browser-mcp": {');
  console.log('           "command": "node",');
  console.log('           "args": ["' + path.join(__dirname, 'dist', 'mcp-server.js').replace(/\\/g, '/') + '"]');
  console.log('         }');
  console.log('       }');
  console.log('     }');
}

function installWindows(manifest) {
  const manifestDir = path.join(getAppDataDir(), 'native-messaging');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Manifest written to: ${manifestPath}`);

  // Register for both Chrome and Edge
  const browsers = [
    { name: 'Chrome', regPath: `Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` },
    { name: 'Edge',   regPath: `Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}` },
  ];

  for (const browser of browsers) {
    try {
      const psCmd = `New-Item -Path 'HKCU:\\${browser.regPath}' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\${browser.regPath}' -Name '(Default)' -Value '${manifestPath}'`;
      execSync(`powershell -Command "${psCmd}"`, { stdio: 'pipe' });
      console.log(`Registry set for ${browser.name}: HKCU\\${browser.regPath}`);
    } catch (err) {
      console.warn(`Warning: Registry write failed for ${browser.name}: ${err.message}`);
    }
  }
}

function installMacOS(manifest) {
  const dirs = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge Canary', 'NativeMessagingHosts'),
  ];
  for (const nmDir of dirs) {
    fs.mkdirSync(nmDir, { recursive: true });
    const manifestPath = path.join(nmDir, `${HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`Manifest written to: ${manifestPath}`);
  }
}

function installLinux(manifest) {
  const dirs = [
    path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts'),
    path.join(os.homedir(), '.config', 'microsoft-edge', 'NativeMessagingHosts'),
  ];
  for (const nmDir of dirs) {
    fs.mkdirSync(nmDir, { recursive: true });
    const manifestPath = path.join(nmDir, `${HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`Manifest written to: ${manifestPath}`);
  }
}

main();
