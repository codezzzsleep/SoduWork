'use strict';

// Diagnostic entry for an installed test bundle. The production main, renderer,
// IPC, utilityProcess runtime and quit policy execute normally. Observers call
// through to the real methods and never delay cleanup or synthesize OS events.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const electron = require('electron');
const { app, BrowserWindow, safeStorage } = electron;
const rootIndex = process.argv.indexOf('--soduwork-native-root');
const binding = path.join(path.resolve(path.dirname(process.execPath), '../../..'), 'native-root.txt');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] :
  fs.existsSync(binding) ? fs.readFileSync(binding, 'utf8').trim() : '';
if (!root || !path.basename(root).startsWith('soduwork-account-five-') ||
    !fs.existsSync(path.join(root, 'native-input.json'))) throw Error('Missing isolated native acceptance root');
const input = JSON.parse(fs.readFileSync(path.join(root, 'native-input.json'), 'utf8'));
const client = path.resolve(__dirname, '..');
const profile = path.join(root, 'profile');
const home = path.join(root, 'home');
for (const directory of [profile, home, input.workspace]) fs.mkdirSync(directory, { recursive: true });
app.setName('SoduWork');
app.setAppPath(client);
app.setPath('userData', profile);
app.setPath('home', home);
app.setPath('documents', input.workspace);
app.setPath('downloads', home);
for (const key of ['appData', 'sessionData', 'temp', 'desktop', 'logs']) {
  const directory = path.join(root, key); fs.mkdirSync(directory, { recursive: true }); app.setPath(key, directory);
}
os.homedir = () => home;
process.chdir(root);
process.env.SODUWORK_USER_DATA = profile;
process.env.SODUWORK_TEST_HUB_URL = input.hub;
process.env.APPDATA = path.join(root, 'appData');
process.env.PI_CODING_AGENT_DIR = path.join(profile, 'pi-agent');
fs.writeFileSync(path.join(profile, 'autostart-initialized'), 'isolated native acceptance');
if (!fs.existsSync(path.join(profile, 'chat-config.json')))
  fs.writeFileSync(path.join(profile, 'chat-config.json'), JSON.stringify({ workDir: input.workspace, mode: 'readonly' }));
// Installed clients use their saved, editable Hub selection. The source-only
// SODUWORK_TEST_HUB_URL override must not replace that production behavior.
if (!fs.existsSync(path.join(profile, 'hub-endpoint.json')))
  fs.writeFileSync(path.join(profile, 'hub-endpoint.json'), JSON.stringify({ hub: input.hub }), { mode: 0o600 });
if (!fs.existsSync(path.join(profile, 'desk-flags.json')))
  fs.writeFileSync(path.join(profile, 'desk-flags.json'), JSON.stringify({ dock: false, pet: false, tray: false }));
require('./fixtures/full-client-isolation.cjs').installNetwork();
app.disableHardwareAcceleration();
const events = path.join(root, 'native-events.jsonl');
const record = (event, value = {}) => fs.appendFileSync(events, JSON.stringify({
  event, at: Date.now(), pid: process.pid, ...value,
}) + '\n');
process.on('uncaughtExceptionMonitor', error => record('uncaught-exception', {
  message: String(error.message).slice(0, 2000), stack: String(error.stack).slice(0, 6000),
}));
let quitting = false;
record('process-start', { packaged: app.isPackaged, files: require('../main/file-open.cjs').commandFiles(process.argv, root, app.isPackaged) });
const quitModule = require('../main/quit-relaunch.cjs');
const originalCreate = quitModule.create;
quitModule.create = function (...args) {
  const state = originalCreate(...args), originalMark = state.markQuitting;
  state.markQuitting = function (...values) {
    const answer = originalMark.apply(state, values);
    quitting = true; record('confirmed-quit');
    fs.writeFileSync(path.join(root, 'confirmed-quit.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return answer;
  };
  return state;
};
const originalRelaunch = app.relaunch.bind(app);
app.relaunch = options => {
  record('relaunch', { files: require('../main/file-open.cjs').commandFiles(['electron', ...options.args], root, app.isPackaged) });
  return originalRelaunch(options);
};
app.on('open-file', (_event, file) => record('open-file', { file, quitting }));
app.on('activate', () => record('activate', { quitting }));
app.on('before-quit', () => record('before-quit', { quitting }));
app.on('will-quit', () => record('will-quit', { quitting }));
app.on('quit', () => record('quit', { quitting }));
const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
const claimNames = new Map();
electron.ipcMain.handle = (name, handler) => originalHandle(name,
  name === 'file-open-claim' ? async (...args) => {
    const answer = await handler(...args);
    if (answer?.ok) { claimNames.set(answer.id, answer.file?.name); record('file-claim', { name: answer.file?.name, id: answer.id }); }
    return answer;
  } : name === 'file-open-ack' ? (...args) => {
    const answer = handler(...args);
    if (answer?.ok) record('file-ack', { name: claimNames.get(args[1]), id: args[1] });
    return answer;
  } : handler);
const originalFork = electron.utilityProcess.fork.bind(electron.utilityProcess);
electron.utilityProcess.fork = (...args) => {
  const child = originalFork(...args);
  let childPid;
  child.once('spawn', () => { childPid = child.pid; record('runtime-spawn', { childPid }); });
  child.once('exit', code => record('runtime-exit', { childPid, code }));
  return child;
};
let window;
app.on('browser-window-created', (_event, candidate) => {
  candidate.on('show', () => record('window-show', { url: candidate.webContents.getURL(), quitting }));
  candidate.webContents.on('did-finish-load', () => {
    if (/\/desk\.html(?:[?#]|$)/.test(candidate.webContents.getURL())) {
      window = candidate;
      record('workspace-loaded');
      candidate.setSize(1000, 700);
    }
  });
});
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  const response = await originalFetch(url, options);
  if (String(url?.url || url).endsWith('/email-challenges') && response.ok) {
    const value = await response.clone().json();
    fs.writeFileSync(path.join(root, 'challenge.json'), JSON.stringify({ challengeId: value.challengeId }));
  }
  return response;
};
const control = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.headers['x-native-key'] !== input.controlKey) { response.writeHead(403); response.end('{}'); return; }
  let raw = '';
  for await (const part of request) { raw += part; if (raw.length > 1000000) throw Error('Oversized diagnostic request'); }
  try {
    const command = JSON.parse(raw || '{}');
    if (command.op === 'status') {
      const locale = require('../main/native-locale.cjs');
      response.end(JSON.stringify({ pid: process.pid, packaged: app.isPackaged, ready: app.isReady(), quitting,
        windowReady: Boolean(window && !window.isDestroyed()),
        quitLabel: locale.translate('确认退出'), cancelLabel: locale.translate('继续使用'),
        encryptionAvailable: app.isReady() && safeStorage.isEncryptionAvailable() })); return;
    }
    if (!window || window.isDestroyed()) throw Error('Workspace is not ready');
    if (command.op === 'eval') {
      const value = await window.webContents.executeJavaScript(`(async()=>{return await eval(${JSON.stringify(command.code)})})()`, true);
      response.end(JSON.stringify({ ok: true, value })); return;
    }
    if (command.op === 'screenshot') {
      const file = path.join(root, path.basename(command.name || 'workspace') + '.png');
      const image = await window.webContents.capturePage(); fs.writeFileSync(file, image.toPNG());
      response.end(JSON.stringify({ ok: true, file })); return;
    }
    throw Error('Unknown diagnostic command');
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ ok: false, error: error.message })); }
});
control.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(root, 'worker-control.json'), JSON.stringify({ port: control.address().port, pid: process.pid }));
});
app.on('will-quit', () => control.close());
// Execute the complete production startup. No runtime adapter, confirmation
// shim, window-operation stub, artificial cleanup delay or provider mock is installed.
require('../main.js');
