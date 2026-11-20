'use strict';

// Isolated fork-only execution scaffolding. Uses the existing macOS CI job;
// production files, quit policy and utility-process entrypoints are unmodified.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const assert = require('node:assert/strict');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Native macOS arm64 runner required');
const repository = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2]);
assert.ok(!output.startsWith(repository + path.sep), 'Generated acceptance evidence must remain outside source');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-macos-toolchain-'));
const client = path.join(repository, 'client');
const report = { ok: false, source: process.env.GITHUB_SHA, platform: process.platform, architecture: process.arch,
  macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  paidServices: false, notarizedReleaseInstaller: false, diagnosticEntry: true, stages: [], errors: [] };
function flush() { fs.writeFileSync(path.join(output, 'setup.json'), JSON.stringify(report, null, 2)); }
function notice(value) {
  const text = JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log('::notice title=macOS native acceptance::' + text);
}
async function stage(name, action) {
  const item = { name, startedAt: new Date().toISOString(), ok: false }; report.stages.push(item); flush();
  console.log('MACOS_NATIVE_STAGE=' + JSON.stringify(item));
  try { const result = await action(); item.ok = true; item.completedAt = new Date().toISOString(); flush(); notice(item); return result; }
  catch (error) { item.error = String(error.message); flush(); notice(item); throw error; }
}
function run(executable, args, options = {}) {
  return execFileSync(executable, args, { cwd: repository, stdio: 'inherit', timeout: 12 * 60 * 1000, ...options });
}
async function download(url, file, expected, algorithm = 'sha256') {
  const response = await fetch(url, { signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw Error('Download failed with HTTP ' + response.status + ': ' + new URL(url).pathname);
  await pipeline(response.body, fs.createWriteStream(file));
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest(algorithm === 'sha512' ? 'base64' : 'hex'), expected, 'Downloaded artifact digest mismatch');
}
function find(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.name === name) return file;
    if (entry.isDirectory()) { const result = find(file, name); if (result) return result; }
  }
}
async function availablePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve)); return port;
}
let server, mounted;
(async () => {
  await stage('native-ui-automation-compilation', () => {
    const scripts = require('./macos-native-system-dialog.cjs');
    for (const press of [false, true])
      run('osacompile', ['-o', path.join(temporary, 'network-' + press + '.scpt'), '-e', scripts.networkPermissionScript(press)], { timeout: 15000 });
    for (const kind of ['finder', 'dock', 'mixed', 'budget']) {
      const source = scripts.deliveryScript({ marker: path.join(temporary, 'marker'), ready: path.join(temporary, 'ready'),
        app: path.join(temporary, 'SoduWork.app'), kind, files: kind === 'dock' ? [] : [path.join(temporary, 'input.txt')] });
      run('osacompile', ['-o', path.join(temporary, 'delivery-' + kind + '.scpt'), '-e', source], { timeout: 15000 });
    }
  });
  await stage('locked-client-dependencies', async () => {
    assert.ok(!fs.existsSync(path.join(client, 'node_modules')), 'Refusing to replace existing dependencies');
    // Use this repository's documented package manager and lockfile to preserve
    // the production package layout and nested dependency overrides.
    const before = fs.readFileSync(path.join(client, 'package-lock.json'));
    run('npm', ['ci'], { cwd: client, env: { ...process.env, CI: 'true' } });
    assert.deepEqual(fs.readFileSync(path.join(client, 'package-lock.json')), before, 'Locked source dependencies changed');
    run(process.execPath, [path.join(client, 'scripts/patch-pi-extension-cache.cjs')]);
    run(process.execPath, [path.join(client, 'scripts/patch-pi-retry-schedule.cjs')]);
  });
  const python = await stage('isolated-backend-and-runner-build-interpreter', async () => {
    const directory = path.join(repository, 'hub-backend/.venv');
    run(process.env.SODUWORK_NATIVE_PYTHON || 'python3', ['-m', 'venv', directory]);
    const interpreter = path.join(directory, 'bin/python');
    run(interpreter, ['-B', '-m', 'pip', 'install', '-r', path.join(repository, 'hub-backend/requirements-test.txt')]);
    return interpreter;
  });
  const model = await stage('hash-verified-free-local-model', async () => {
    const archive = path.join(temporary, 'llama.tar.gz');
    await download('https://github.com/ggml-org/llama.cpp/releases/download/b12590/llama-b12590-bin-macos-arm64.tar.gz', archive,
      'c0961e9c1ee87fb17357825a8f4a0a294ce7334093e1295917f71f17977d5ad6');
    const directory = path.join(temporary, 'llama'); fs.mkdirSync(directory); run('tar', ['-xzf', archive, '-C', directory]);
    const modelFile = path.join(temporary, 'Qwen3-0.6B-Q8_0.gguf');
    const sha256 = '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031';
    await download('https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf', modelFile, sha256);
    const port = await availablePort(), modelURL = 'http://127.0.0.1:' + port;
    const log = fs.openSync(path.join(output, 'llama-server.log'), 'w');
    server = spawn(find(directory, 'llama-server'), ['--model', modelFile, '--alias', 'native-qwen',
      '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '32768', '--parallel', '1',
      '--threads', '3', '--n-gpu-layers', '0', '--chat-template-kwargs', '{"enable_thinking":false}'],
    { stdio: ['ignore', log, log], env: { ...process.env } });
    fs.closeSync(log);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw Error('Local model server exited ' + server.exitCode);
      try { const response = await fetch(modelURL + '/health', { signal: AbortSignal.timeout(2000) }); if (response.ok) break; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal((await fetch(modelURL + '/health')).ok, true, 'Local model did not become ready');
    const evidence = { repository: 'Qwen/Qwen3-0.6B-GGUF', revision: '23749fefcc72300e3a2ad315e1317431b06b590a',
      file: path.basename(modelFile), sha256, bytes: fs.statSync(modelFile).size, license: 'Apache-2.0',
      engine: 'llama.cpp b12590', serverPid: server.pid };
    report.model = evidence; flush(); return { evidence, modelURL };
  });
  const installer = await stage('build-and-mount-native-diagnostic-dmg', async () => {
    const configuration = path.join(temporary, 'native-build.cjs');
    fs.writeFileSync(configuration, `'use strict';\nconst base=require(${JSON.stringify(path.join(client, 'scripts/public-build-config.cjs'))});\nmodule.exports={...base,files:[...base.files,'e2e/macos-native-client-worker.cjs','e2e/fixtures/full-client-isolation.cjs'],extraMetadata:{...base.extraMetadata,main:'e2e/macos-native-client-worker.cjs'},directories:{...base.directories,output:${JSON.stringify(path.join(output, 'packages'))}}};\n`);
    const environment = { ...process.env, SODUWORK_MACOS_ARCH: 'arm64', SODUWORK_MACOS_ARM64_PYTHON: python,
      SODUWORK_INTERNAL_BUILD: '1', SODUWORK_MAC_RELEASE: '0', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      SODUWORK_PYTHON_MIRROR: '', SODUWORK_NODE_MIRROR: '' };
    require(path.join(client, 'scripts/build-macos.cjs')).build({ root: repository, env: environment,
      run(executable, args, options) {
        const values = [...args], index = values.indexOf('--config');
        if (index >= 0) values[index + 1] = configuration;
        return execFileSync(executable, values, { timeout: 12 * 60 * 1000, ...options });
      } });
    const file = fs.readdirSync(path.join(output, 'packages')).find(name => name.endsWith('.dmg'));
    assert.ok(file, 'Native DMG was not built');
    mounted = path.join(output, 'mounted'); fs.mkdirSync(mounted);
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mounted, path.join(output, 'packages', file)]);
    const app = path.join(mounted, 'SoduWork.app'); assert.ok(fs.existsSync(app));
    run('codesign', ['--verify', '--deep', '--strict', app]);
    report.installer = { filename: file, nativeDmgMounted: true, codeSignatureVerified: true,
      diagnosticMain: true, developerIdNotarized: false, currentSourceRuntimeBuild: true,
      dependencyPackaging: 'Canonical committed npm lockfile and unchanged public beforePack pipeline',
      officialBeforePackAcceptance: true }; flush();
    return { app, evidence: report.installer };
  });
  await stage('native-finder-dock-live-model-and-profile-acceptance', async () => {
    const specification = path.join(output, 'input.json');
    fs.writeFileSync(specification, JSON.stringify({ output, repository, python, app: installer.app,
      source: report.source, macOS: report.macOS, model: model.evidence, modelURL: model.modelURL,
      installer: installer.evidence }));
    run(process.execPath, [path.join(client, 'e2e/macos-native-reopen.cjs'), specification], { timeout: 18 * 60 * 1000 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'acceptance.json'))).ok, true);
  });
  report.ok = true;
})().catch(error => { report.errors.push(String(error.stack || error)); process.exitCode = 1; }).finally(() => {
  if (server?.exitCode === null) server.kill('SIGTERM');
  if (mounted) { try { run('hdiutil', ['detach', mounted], { timeout: 20000 }); } catch (error) { report.errors.push(String(error.message)); } }
  flush(); console.log('MACOS_NATIVE_SETUP_JSON=' + JSON.stringify(report));
});
