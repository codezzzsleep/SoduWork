'use strict';

// Production conversation controllers and Chromium click bindings; only service boundaries are synthetic.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', timeout: 120000 });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
const revision = process.argv.find(value => value.startsWith('--revision='))?.slice(11);
const read = file => revision ? require('node:child_process').execFileSync('git', ['show', revision + ':client/' + file],
  { cwd: client, encoding: 'utf8' }) : fs.readFileSync(path.join(client, file), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-acceptance-send-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
const report = { ok: false, revision: revision || 'working-tree', checks: [], errors: [], network: [], cleanup: { ok: false },
  boundary: 'Real Electron Chromium, production NativeChat, task activation, archive open, composer controls, input bindings and send controller. Hub context, model catalogs and native conversation IPC are synthetic. Unrelated shell, plugin and queue modules use existing unit-fixture doubles. No provider, real account, production profile or operating-system task execution.' };
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await js(code)) return; await delay(25); }
  throw Error('Timed out: ' + code + '\nState: ' + JSON.stringify(await state()));
}
const state = () => js(`({input:document.querySelector('#nchatInput')?.value,disabled:document.querySelector('#nchatSend')?.disabled,
  title:document.querySelector('#nchatSend')?.title,sendState:fixtureContext?._sendState,stopState:fixtureContext?._stopState,
  ref:fixtureContext?._ref,openBlocked:fixtureContext?._snap?.openBlocked,controls:!!fixtureContext?._composerControls,
  clicks:window.clicks,pending:fixtureContext?._pending,sends:calls.filter(row=>row.kind==='send').length,models:modelCalls,
  selection:fixtureContext?._snap?.modelSelection,enterPresses:window.enterPresses,
  modelReads:window.modelReads,notice:document.querySelector('.nbad.show')?.textContent||'',statusText:fixtureContext?._snap?.statusText,toasts,errors})`);
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});
    const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    if(e.disabled||!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Control unavailable: '+${JSON.stringify(selector)});return p;})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
}
async function shot(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
const mark = value => { report.checks.push(value); console.log('PASS ' + value); };
app.whenReady().then(async () => {
  try {
    const css = [...read('desk.html').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(match => match[1]);
    const html = path.join(temporary, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + css.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{margin:0;padding:20px;background:#fafafa}#composePanel{height:900px;display:block}#cpChat{display:block;height:100%}.nchat{height:100%}</style>' +
      '</head><body><main id="composePanel"><div id="cpChat"></div></main></body></html>');
    win = new BrowserWindow({ show: false, width: 1360, height: 1020,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      report.network.push(request.url); done({ cancel: true });
    });
    await win.loadFile(html); win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await require('./lib/conversation-send-harness.cjs').install(win, read);
    await js(`window.activateAcceptance=()=>NativeChat.openTask(task.id,task.title,{task,chatId:'restored-chat',source:'acceptance',
      acceptanceExecutionSession:true,acceptanceMode:'auto',approvalId:'synthetic-approval'});void 0;`);
    assert.equal(await js('activateAcceptance()'), true);
    await until(`document.querySelector('#nchatInput')?.value.startsWith('【自动验收】')`);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
    assert.equal(await js('fixtureContext._sessionOptions.acceptanceMode'), 'auto');
    mark('Restoring the saved task conversation activates production auto-acceptance context and prefills without sending');
    await shot('01-prefilled');

    await js(`catalogMode='reject';void 0;`);
    const before = await state(); await click('#nchatSend');
    await until(`document.querySelector('.nbad.show')?.textContent.includes('模型列表')`);
    await until(`fixtureContext._sendState==='idle'`);
    const rejected = await state(); report.rejected = rejected;
    assert.equal(rejected.input, before.input); assert.equal(rejected.sends, 0);
    assert.equal(rejected.disabled, false); assert.match(rejected.notice, /模型列表/);
    assert.equal(rejected.selection.name, 'glm5.2'); assert.equal(rejected.selection.model.unavailable, undefined);
    assert.ok(rejected.modelReads.includes('reject'), 'The fixture must reach the actual managed-model directory failure');
    mark('A rejected send-time catalog read retains the acceptance draft, reports the failure and restores an actionable send button');
    await shot('02-directory-failure');

    await js(`catalogMode='ok';void 0;`); await click('#nchatSend');
    await until(`calls.filter(row=>row.kind==='send').length===1`);
    await until(`fixtureContext._sendState==='idle'`);
    const sent = await js('calls.find(row=>row.kind==="send")');
    assert.equal(sent.options.taskId, 'acceptance-task');
    assert.equal(sent.options.taskExecution.acceptanceOnly, true);
    assert.equal(sent.options.taskExecution.acceptanceMode, 'auto');
    assert.equal(sent.options.taskExecution.acceptanceExecutionSession, true);
    assert.equal(sent.options.taskExecution.approvalId, 'synthetic-approval');
    assert.equal((await state()).input, '');
    mark('A real mouse click after catalog recovery sends exactly once with the pinned auto-acceptance options');
    await shot('03-recovered-send');

    assert.equal(await js('activateAcceptance()'), true);
    await js(`catalogMode='hang';window.waiterStart=catalogWaiters.length;void 0;`);
    const refreshDraft = (await state()).input; await click('#nchatSend');
    await until(`catalogWaiters.length>waiterStart`);
    const reading = await state(); assert.equal(reading.input, refreshDraft);
    assert.equal(reading.disabled, true); assert.equal(reading.sendState, 'sending');
    assert.equal(reading.sends, 1); assert.match(reading.title, /发送中/);
    await shot('04-catalog-in-flight');
    await js(`catalogMode='ok';modelsChanged();void 0;`);
    await until(`calls.filter(row=>row.kind==='send').length===2`);
    await until(`fixtureContext._sendState==='idle'`);
    await js(`for(const resolve of catalogWaiters.splice(0))resolve({usable:[]});void 0;`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 2);
    assert.equal(await js('fixtureContext._snap.modelSelection.name'), 'glm5.2');
    mark('A model-change refresh supersedes a hung directory read, sends once and ignores the late stale empty catalog');

    assert.equal(await js('activateAcceptance()'), true);
    await js(`catalogMode='hang';window.waiterStart=catalogWaiters.length;void 0;`);
    const hubTimeoutDraft = (await state()).input; await click('#nchatSend');
    await until(`catalogWaiters.length>waiterStart`);
    await until(`document.querySelector('.nbad.show')?.textContent.includes('超时')&&fixtureContext._sendState==='idle'`, 16000);
    report.hubTimedOut = await state();
    assert.equal(report.hubTimedOut.input, hubTimeoutDraft); assert.equal(report.hubTimedOut.sends, 2);
    assert.equal(report.hubTimedOut.selection.name, 'glm5.2'); assert.equal(report.hubTimedOut.selection.model.unavailable, undefined);
    await shot('05-hub-catalog-timeout');
    await js(`catalogMode='ok';void 0;`); await click('#nchatSend');
    await until(`calls.filter(row=>row.kind==='send').length===3&&fixtureContext._sendState==='idle'`);
    await js(`for(const resolve of catalogWaiters.splice(0))resolve({usable:[]});void 0;`);
    mark('A Hub catalog timeout preserves the known model and acceptance draft, then an explicit retry sends once');

    await js(`NativeChat.reset();model={id:'local:model-'+ 'b'.repeat(32),name:'local:model-'+ 'b'.repeat(32),label:'Local review model',localOnly:true};void 0;`);
    assert.equal(await js('activateAcceptance()'), true);
    await js(`catalogMode='hang';window.waiterStart=catalogWaiters.length;void 0;`);
    const timeoutDraft = (await state()).input; await click('#nchatSend');
    await until(`catalogWaiters.length>waiterStart`);
    await until(`document.querySelector('.nbad.show')?.textContent.includes('超时')&&fixtureContext._sendState==='idle'`, 16000);
    const timedOut = await state(); report.timedOut = timedOut;
    assert.equal(timedOut.input, timeoutDraft); assert.equal(timedOut.sends, 3); assert.equal(timedOut.disabled, false);
    assert.equal(timedOut.selection.name, 'local:model-' + 'b'.repeat(32)); assert.equal(timedOut.selection.model.unavailable, undefined);
    await shot('06-local-catalog-timeout');
    await js(`catalogMode='ok';void 0;`); await click('#nchatSend');
    await until(`calls.filter(row=>row.kind==='send').length===4`);
    await until(`fixtureContext._sendState==='idle'`);
    const localSend = await js('calls.filter(row=>row.kind==="send").at(-1)');
    assert.equal(localSend.options.taskExecution.acceptanceOnly, true);
    assert.equal(localSend.options.taskExecution.acceptanceMode, 'auto');
    assert.equal(localSend.options.taskExecution.approvalId, 'synthetic-approval');
    assert.equal((await state()).input, '');
    assert.equal(await js('fixtureContext._snap.modelSelection.name'), 'local:model-' + 'b'.repeat(32));
    await js(`for(const resolve of catalogWaiters.splice(0))resolve({usable:[]});void 0;`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 4);
    mark('A hung local-model catalog reaches its real deadline, retains the draft and permits exactly one auto-acceptance retry');
    await shot('07-local-recovered-send');

    assert.equal(await js('activateAcceptance()'), true);
    await js(`fixtureContext._snap={...idle(),status:'streaming',execution:{running:true}};fixtureContext._render();
      catalogMode='hang';window.waiterStart=catalogWaiters.length;document.querySelector('#nchatInput').focus();void 0;`);
    const enter = () => { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' }); };
    enter(); await until(`catalogWaiters.length>waiterStart`); enter();
    await until('enterPresses.length===2'); assert.deepEqual(await js('enterPresses'), [true, true]);
    await js(`catalogMode='ok';modelsChanged();void 0;`);
    await until(`calls.filter(row=>row.kind==='send').length>=5`);
    await until(`fixtureContext._sendState==='idle'`);
    await js(`for(const resolve of catalogWaiters.splice(0))resolve({usable:[]});void 0;`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 5);
    assert.equal(await js('calls.filter(row=>row.kind==="send").at(-1).options.taskExecution.acceptanceMode'), 'auto');
    mark('Repeated real Enter presses while the runtime is busy and catalog preflight is pending admit the acceptance draft once');

    await js(`fixtureContext._snap={...idle(),status:'streaming',execution:{running:true}};fixtureContext._render();
      window.holdNextSend=true;document.querySelector('#nchatInput').focus();void 0;`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'First explicit acceptance follow-up.' });
    enter(); await until(`calls.filter(row=>row.kind==='send').length===6&&!!window.releaseSend`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'Second explicit acceptance follow-up.' });
    enter(); await until(`document.querySelector('#nchatInput').value===''`);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 6);
    await js(`releaseSend();window.releaseSend=null;void 0;`);
    await until(`calls.filter(row=>row.kind==='send').length===7&&fixtureContext._sendState==='idle'`);
    assert.deepEqual(await js('calls.filter(row=>row.kind==="send").slice(-2).map(row=>row.text)'),
      ['First explicit acceptance follow-up.', 'Second explicit acceptance follow-up.']);
    mark('A different draft can enter the submission queue while the prior native send receipt is still pending');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.network, []); report.ok = true;
  } catch (error) {
    report.errors.push(error.stack || String(error));
    try { report.failureState = await state(); await shot('failure'); } catch (failure) { report.errors.push(failure.stack || String(failure)); }
  }
  finally {
    try { win?.destroy(); fs.rmSync(temporary, { recursive: true, force: true }); report.cleanup.ok = true; }
    catch (error) { report.ok = false; report.cleanup.error = error.stack || String(error); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, errors: report.errors, cleanup: report.cleanup }));
    app.exit(report.ok ? 0 : 1);
  }
});
