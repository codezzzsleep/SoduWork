'use strict';

// Source startup runs this in a dedicated download child, never the desktop or
// model runtime. Resolve the same undici as the locked @electron/get package.
const path = require('node:path');
const { createRequire } = require('node:module');

function installElectron({ installer = path.join(__dirname, '../node_modules/electron/install.js'),
  env = process.env, requireFrom = createRequire } = {}) {
  const install = requireFrom(installer);
  const switchValue = String(env.ELECTRON_GET_USE_PROXY || '').trim().toLowerCase();
  const useProxy = !['', '0', 'false', 'no', 'off'].includes(switchValue);
  if (env.ELECTRON_GET_USE_PROXY !== undefined) env.ELECTRON_GET_USE_PROXY = '';
  if (useProxy) {
    let proxy;
    try {
      const fromGet = requireFrom(install.resolve('@electron/get'));
      proxy = fromGet('undici');
      if (typeof proxy.EnvHttpProxyAgent !== 'function' || typeof proxy.setGlobalDispatcher !== 'function') {
        throw new Error('Unsupported proxy dependency');
      }
    } catch (_) {
      // @electron/get's optional proxy initialization logs and then goes direct.
      // Fail before its installer runs instead of ignoring the selected proxy.
      throw new Error('Electron proxy support is unavailable. Run npm ci in client/ and retry.');
    }
    try {
      proxy.setGlobalDispatcher(new proxy.EnvHttpProxyAgent());
    } catch (_) {
      throw new Error('Electron proxy configuration is invalid. Check HTTP_PROXY and HTTPS_PROXY, then retry.');
    }
  }
  // The dispatcher is already installed, or the user opted out. Keep the
  // downloader from running its silent optional-dependency fallback below.
  return install(installer);
}

if (require.main === module) {
  try { installElectron(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { installElectron };
