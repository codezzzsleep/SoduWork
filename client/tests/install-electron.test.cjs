'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { installElectron } = require('../scripts/install-electron.cjs');

function dependencies({ proxy, env = {} } = {}) {
  const calls = [];
  const installer = path.resolve('fixture/electron/install.js');
  const get = path.resolve('fixture/@electron/get/index.js');
  const install = target => { calls.push(['install', target]); return 'installed'; };
  install.resolve = name => { assert.equal(name, '@electron/get'); return get; };
  const requireFrom = source => {
    if (source === installer) return install;
    assert.equal(source, get);
    return name => { assert.equal(name, 'undici'); calls.push(['proxy']); return proxy(); };
  };
  return { installer, env, requireFrom, calls };
}

test('the installer uses its own @electron/get proxy before loading Electron and prevents silent fallback', () => {
  const env = { ELECTRON_GET_USE_PROXY: '1', HTTPS_PROXY: 'http://fixture.invalid:8080',
    ELECTRON_MIRROR: 'https://mirror.invalid/electron/' };
  const f = dependencies({ env, proxy: () => ({
    EnvHttpProxyAgent: class { constructor() { f.calls.push(['agent']); } },
    setGlobalDispatcher(agent) { f.calls.push(['dispatcher', agent.constructor.name]); },
  }) });
  assert.equal(installElectron(f), 'installed');
  assert.deepEqual(f.calls.map(row => row[0]), ['proxy', 'agent', 'dispatcher', 'install']);
  assert.equal(env.ELECTRON_GET_USE_PROXY, '');
  assert.equal(env.HTTPS_PROXY, 'http://fixture.invalid:8080');
  assert.equal(env.ELECTRON_MIRROR, 'https://mirror.invalid/electron/');
});

test('a direct or explicitly opted-out install does not require or initialize proxy dependencies', () => {
  for (const env of [{}, ...['', '0', 'false', 'no', ' OFF '].map(value => ({ ELECTRON_GET_USE_PROXY: value }))]) {
    const f = dependencies({ env, proxy() { assert.fail('Proxy must remain disabled'); } });
    assert.equal(installElectron(f), 'installed');
    assert.deepEqual(f.calls, [['install', f.installer]]);
  }
});

test('missing or incompatible undici fails before Electron instead of silently going direct', () => {
  for (const proxy of [() => { throw Error('missing http://private-user:private-password@proxy.invalid'); },
    () => ({}), () => ({ EnvHttpProxyAgent() {} })]) {
    const f = dependencies({ env: { ELECTRON_GET_USE_PROXY: '1' }, proxy });
    assert.throws(() => installElectron(f), error => {
      assert.match(error.message, /Electron proxy support is unavailable/);
      assert.ok(!error.message.includes('private-'));
      return true;
    });
    assert.deepEqual(f.calls, [['proxy']]);
  }
});

test('invalid proxy configuration is reported without its credentials and never loads Electron', () => {
  const f = dependencies({ env: { ELECTRON_GET_USE_PROXY: '1' }, proxy: () => ({
    EnvHttpProxyAgent: class { constructor() { throw Error('http://private-user:private-password@proxy.invalid'); } },
    setGlobalDispatcher() { assert.fail('Invalid proxy cannot become global'); },
  }) });
  assert.throws(() => installElectron(f), error => {
    assert.match(error.message, /Electron proxy configuration is invalid/);
    assert.ok(!error.message.includes('private-'));
    return true;
  });
  assert.deepEqual(f.calls, [['proxy']]);
});

test('the real downloader dispatcher reaches an unresolved artifact host through the selected proxy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-electron-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  write('node_modules/@electron/get/index.js', 'module.exports = {};');
  write('node_modules/undici/index.js', 'module.exports = require(' + JSON.stringify(require.resolve('undici')) + ');');
  const installer = write('node_modules/electron/install.js', `
    fetch('http://electron-artifact.invalid/fixture.zip').then(async response => {
      if (await response.text() !== 'artifact-fixture') process.exit(3);
      console.log('fixture installed'); process.exit(0);
    }).catch(() => process.exit(4));
  `);
  const tunnels = [], sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    tunnels.push(request.url);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nartifact-fixture'));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  const env = { ...process.env, ELECTRON_GET_USE_PROXY: '1',
    HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port, HTTPS_PROXY: '', NO_PROXY: '' };
  for (const key of ['http_proxy', 'https_proxy', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS']) delete env[key];
  const script = 'require(' + JSON.stringify(require.resolve('../scripts/install-electron.cjs')) +
    ').installElectron({ installer: ' + JSON.stringify(installer) + ' });';
  const output = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', script],
    { env, timeout: 10000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(output.trim(), 'fixture installed');
  assert.deepEqual(tunnels, ['electron-artifact.invalid:80']);
});
