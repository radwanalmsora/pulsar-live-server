'use strict';
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { LiveServer } = require('./src/server');

/** @type {Map<string, {srv: LiveServer, folder: vscode.WorkspaceFolder, watcher: vscode.FileSystemWatcher, overrides: Map<string,string>, timer: any, clients: number}>} */
const sessions = new Map();
let statusItem, output;

const cfg = folder => vscode.workspace.getConfiguration('pulsar', folder ? folder.uri : undefined);
const log = m => output.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);

function globToRegex(g) {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { r += '.*'; i++; if (g[i + 1] === '/') i++; } else r += '[^/]*';
    } else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$');
}

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

async function pickFolder(uri) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) { vscode.window.showWarningMessage('Pulsar: open a folder first.'); return; }
  if (uri) { const f = vscode.workspace.getWorkspaceFolder(uri); if (f) return f; }
  if (folders.length === 1) return folders[0];
  const ed = vscode.window.activeTextEditor;
  if (ed) { const f = vscode.workspace.getWorkspaceFolder(ed.document.uri); if (f) return f; }
  const pick = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, f })), { placeHolder: 'Select workspace folder' });
  return pick && pick.f;
}

function relUrl(sess, fsPath) {
  const rel = path.relative(sess.srv.opts.root, fsPath);
  if (rel.startsWith('..')) return null;
  return '/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

function baseUrl(sess, host) {
  const h = host || (sess.srv.opts.host === '0.0.0.0' ? 'localhost' : sess.srv.opts.host);
  return `${sess.srv.scheme}://${h}:${sess.srv.port}`;
}

async function start(folder, openUri) {
  const key = folder.uri.toString();
  if (sessions.has(key)) return sessions.get(key);
  const c = cfg(folder);
  const root = path.join(folder.uri.fsPath, c.get('root', '/'));
  const overrides = new Map();
  const https = c.get('https', {});
  const srv = new LiveServer({
    root, host: c.get('host', 'localhost'), port: c.get('port', 5500),
    https: https && https.enable ? https : null,
    cors: c.get('cors'), headers: c.get('headers'), spa: c.get('spa'),
    directoryListing: c.get('directoryListing'), injectTag: c.get('injectTag'),
    proxy: c.get('proxy'), getOverride: p => overrides.get(p)
  });
  try {
    await srv.start();
  } catch (e) {
    vscode.window.showErrorMessage('Pulsar: failed to start — ' + e.message);
    log('ERROR ' + e.message);
    return;
  }
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
  const sess = { srv, folder, watcher, overrides, timer: null, clients: 0 };
  sessions.set(key, sess);
  srv.on('clients', n => { sess.clients = n; updateStatus(); });

  const ignore = c.get('ignoreFiles', []).map(globToRegex);
  const debounce = c.get('debounce', 80);
  const cssInject = c.get('cssInjection', true);
  const fire = fsPath => {
    const rel = path.relative(folder.uri.fsPath, fsPath).split(path.sep).join('/');
    if (rel.startsWith('..') || ignore.some(r => r.test(rel))) return;
    const url = relUrl(sess, fsPath);
    if (!url) return;
    clearTimeout(sess.timer);
    sess.timer = setTimeout(() => {
      log('changed ' + rel);
      if (cssInject && /\.css$/i.test(fsPath)) srv.css(url); else srv.reload(url);
    }, debounce);
  };
  watcher.onDidChange(u => fire(u.fsPath));
  watcher.onDidCreate(u => fire(u.fsPath));
  watcher.onDidDelete(u => fire(u.fsPath));
  sess.disposables = [watcher];

  if (c.get('reloadOnType')) {
    sess.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        const d = e.document;
        if (d.uri.scheme !== 'file' || !d.isDirty || !/\.(html?|css|js|mjs|xhtml)$/i.test(d.fileName)) return;
        if (!vscode.workspace.getWorkspaceFolder(d.uri) || vscode.workspace.getWorkspaceFolder(d.uri).uri.toString() !== key) return;
        overrides.set(d.fileName, d.getText());
        fire(d.fileName);
      }),
      vscode.workspace.onDidSaveTextDocument(d => overrides.delete(d.fileName)),
      vscode.workspace.onDidCloseTextDocument(d => overrides.delete(d.fileName))
    );
  }

  log(`Server started at ${baseUrl(sess)} (root: ${root})`);
  if (c.get('notifications')) vscode.window.setStatusBarMessage(`$(broadcast) Pulsar live at ${baseUrl(sess)}`, 4000);
  updateStatus();

  if (c.get('openOnStart') || openUri) {
    const target = openUri ? relUrl(sess, openUri.fsPath) || '/' : '/';
    openBrowser(sess, target);
  }
  return sess;
}

async function stop(sess) {
  clearTimeout(sess.timer);
  (sess.disposables || []).forEach(d => d.dispose());
  await sess.srv.stop();
  sessions.delete(sess.folder.uri.toString());
  log('Server stopped: ' + sess.folder.name);
  if (cfg(sess.folder).get('notifications')) vscode.window.setStatusBarMessage('$(circle-slash) Pulsar stopped', 3000);
  updateStatus();
}

async function openBrowser(sess, urlPath) {
  const c = cfg(sess.folder);
  const url = baseUrl(sess) + (urlPath || '/');
  const b = c.get('browser', 'default');
  const args = c.get('browserArgs', []);
  if (!b || b === 'default') {
    try { return await vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(url))); }
    catch (e) { return vscode.env.openExternal(vscode.Uri.parse(url)); }
  }
  const names = {
    chrome: { win: 'chrome', mac: 'Google Chrome', linux: 'google-chrome' },
    firefox: { win: 'firefox', mac: 'Firefox', linux: 'firefox' },
    edge: { win: 'msedge', mac: 'Microsoft Edge', linux: 'microsoft-edge' },
    brave: { win: 'brave', mac: 'Brave Browser', linux: 'brave-browser' },
    opera: { win: 'opera', mac: 'Opera', linux: 'opera' },
    safari: { win: 'safari', mac: 'Safari', linux: 'safari' }
  };
  const k = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const app = (names[b.toLowerCase()] || {})[k] || b;
  let child;
  try {
    if (k === 'win') child = cp.spawn('cmd', ['/c', 'start', '""', app, ...args, url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    else if (k === 'mac') child = cp.spawn('open', ['-a', app, url, ...(args.length ? ['--args', ...args] : [])], { detached: true, stdio: 'ignore' });
    else child = cp.spawn(app, [...args, url], { detached: true, stdio: 'ignore' });
    child.on('error', () => vscode.env.openExternal(vscode.Uri.parse(url)));
    child.unref();
  } catch (e) { vscode.env.openExternal(vscode.Uri.parse(url)); }
}

function updateStatus() {
  const n = sessions.size;
  if (!n) {
    statusItem.text = '$(broadcast) Go Live';
    statusItem.tooltip = 'Pulsar Live Server — click to start (Ctrl+Alt+L)';
    statusItem.backgroundColor = undefined;
  } else {
    const s = [...sessions.values()];
    const ports = s.map(x => x.srv.port).join(', ');
    const clients = s.reduce((a, x) => a + x.clients, 0);
    statusItem.text = `$(pulse) Port: ${ports}` + (clients ? ` · ${clients}` : '');
    statusItem.tooltip = `Pulsar is live — ${clients} browser(s) connected. Click to stop.`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
  }
  statusItem.show();
}

async function activate(context) {
  output = vscode.window.createOutputChannel('Pulsar Live Server');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'pulsar.toggle';
  updateStatus();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('pulsar.start', async uri => { const f = await pickFolder(uri); if (f) await start(f); });
  reg('pulsar.stop', async () => {
    if (!sessions.size) return;
    if (sessions.size === 1) return stop([...sessions.values()][0]);
    const pick = await vscode.window.showQuickPick([...sessions.values()].map(s => ({ label: s.folder.name, description: baseUrl(s), s })), { placeHolder: 'Stop which server?' });
    if (pick) await stop(pick.s);
  });
  reg('pulsar.toggle', async () => {
    const f = await pickFolder();
    if (!f) return;
    const s = sessions.get(f.uri.toString());
    if (s) await stop(s); else await start(f);
  });
  reg('pulsar.openFile', async uri => {
    uri = uri && uri.fsPath ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!uri) return vscode.window.showWarningMessage('Pulsar: no file selected.');
    const f = await pickFolder(uri);
    if (!f) return;
    const s = sessions.get(f.uri.toString());
    if (s) openBrowser(s, relUrl(s, uri.fsPath) || '/'); else await start(f, uri);
  });
  reg('pulsar.reloadAll', () => sessions.forEach(s => s.srv.reload()));
  reg('pulsar.showLog', () => output.show(true));
  reg('pulsar.showUrls', async () => {
    if (!sessions.size) return vscode.window.showInformationMessage('Pulsar: server is not running.');
    const items = [];
    for (const s of sessions.values()) {
      items.push({ label: '$(device-desktop) ' + baseUrl(s), description: 'This computer · ' + s.folder.name });
      if (s.srv.opts.host === '0.0.0.0') for (const ip of localIPs()) items.push({ label: '$(device-mobile) ' + baseUrl(s, ip), description: 'Phone / tablet on the same Wi-Fi' });
    }
    if (!items.some(i => i.label.includes('device-mobile'))) items.push({ label: '$(info) Set "pulsar.host" to 0.0.0.0 to test on your phone', description: '' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a URL to copy' });
    if (pick && pick.label.includes('://')) {
      await vscode.env.clipboard.writeText(pick.label.replace(/^\$\([^)]+\)\s*/, ''));
      vscode.window.setStatusBarMessage('$(check) URL copied', 2500);
    }
  });

  context.subscriptions.push(statusItem, output);
}

async function deactivate() {
  await Promise.all([...sessions.values()].map(stop));
}

module.exports = { activate, deactivate };
