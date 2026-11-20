'use strict';

// Actual installed-client acceptance: production main/preload/desk, native
// Finder/Dock and native quit dialog, production utilityProcess, and a real
// local Qwen inference server. The isolated Hub/SMTP fixture is not a model.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.platform !== 'darwin') throw Error('Actual macOS is required');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const output = input.output;
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, scope: 'Installed diagnostic bundle and production client; native UI/OS events; real local Qwen inference',
  source: input.source, model: input.model, macOS: input.macOS, architecture: process.arch,
  notarizedReleaseInstaller: false, installer: input.installer, cases: [], modelRequests: [], errors: [], screenshots: [] };
const flush = () => fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
let nonce = '';
const proxy = http.createServer((request, response) => {
  let raw = ''; request.on('data', part => { raw += part; });
  request.on('end', () => {
    let data;
    try { data = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
    const row = { at: Date.now(), model: data.model, acceptanceTask: JSON.stringify(data.messages || []).includes(nonce),
      streamCharacters: 0, active: true };
    report.modelRequests.push(row);
    const destination = new URL('/v1/chat/completions', input.modelURL);
    const upstream = http.request(destination, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, stream => {
      row.status = stream.statusCode;
      response.writeHead(stream.statusCode, stream.headers);
      let pending = '';
      stream.on('data', part => {
        pending += part.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try { const frame=JSON.parse(line.slice(6)); const delta=frame.choices?.[0]?.delta;
            row.streamCharacters += String(delta?.content || delta?.reasoning_content || '').length;
          } catch {}
        }
      });
      stream.on('end', () => { row.active = false; row.endedAt = Date.now(); });
      stream.pipe(response);
    });
    upstream.on('error', error => { row.active = false; row.error = error.message; if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { row.active = false; row.closedAt = Date.now(); upstream.destroy(); });
    upstream.end(raw);
  });
});

async function until(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const answer = await predicate(); if (answer) return answer; } catch (error) { last = error.message; }
    await delay(30);
  }
  throw Error('Timed out: ' + label + (last ? '; ' + last : ''));
}
async function apple(script, timeout = 25000) {
  const value = await execute('osascript', ['-e', script], { timeout, maxBuffer: 1024 * 1024 });
  return value.stdout.trim();
}
function literal(value) { return JSON.stringify(String(value)); }
async function nativeFiles(files, app) {
  const values = files.map(file => `(POSIX file ${literal(file)} as alias)`).join(',');
  return apple(`tell application "Finder" to open {${values}} using (POSIX file ${literal(app)} as alias)`);
}
async function nativeDock() {
  return apple('tell application "System Events" to tell process "Dock"\n' +
    'set targetItem to first UI element of list 1 whose description is "SoduWork"\n' +
    'perform action "AXPress" of targetItem\nend tell');
}
async function nativeButton(pid, label) {
  return apple(`tell application "System Events"\nset p to first process whose unix id is ${pid}\n` +
    `tell p\nset frontmost to true\nrepeat 200\nrepeat with w in windows\n` +
    `if exists sheet 1 of w then\nif exists button ${literal(label)} of sheet 1 of w then\n` +
    `click button ${literal(label)} of sheet 1 of w\nreturn "clicked"\nend if\nend if\n` +
    `if exists button ${literal(label)} of w then\nclick button ${literal(label)} of w\nreturn "clicked"\nend if\n` +
    'end repeat\ndelay 0.025\nend repeat\nerror "Native quit confirmation button not found"\nend tell\nend tell');
}
async function screenshot(root, kind, name, native = false) {
  let file;
  if (native) {
    file = path.join(root, name + '.png');
    await execute('screencapture', ['-x', file], { timeout: 15000 });
  } else file = (await rpc(root, 'screenshot', { name })).file;
  const target = path.join(output, kind + '-' + name + '.png');
  fs.copyFileSync(file, target);
  report.screenshots.push({ kind, name, file: path.basename(target) });
  flush();
}
async function startHub(root) {
  const child = spawn(input.python, ['-B', path.join(input.repository, 'client/e2e/fixtures/full_client_hub_fixture.py'), '--root', root],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '', errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-6000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Hub startup timed out: ' + errors)), 90000);
    child.stdout.on('data', part => { text += part; const match = text.match(/ACCOUNT_FIXTURE_READY (\{[^\n]+\})/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(Error('Hub exited ' + code + ': ' + errors)); });
  });
  return { child, url: 'http://127.0.0.1:' + ready.port, key: ready.key };
}
function eventRows(root) {
  const file = path.join(root, 'native-events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
async function rpc(root, op, values = {}) {
  const connection = JSON.parse(fs.readFileSync(path.join(root, 'worker-control.json'), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'native-input.json'), 'utf8'));
  const response = await fetch('http://127.0.0.1:' + connection.port, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Native-Key': spec.controlKey },
    body: JSON.stringify({ op, ...values }), signal: AbortSignal.timeout(20000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Diagnostic request failed');
  return result;
}
async function js(root, code) { return (await rpc(root, 'eval', { code })).value; }
async function fill(root, selector, value) {
  await until(() => js(root, `Boolean(document.querySelector(${literal(selector)}))`), selector);
  await js(root, `(()=>{const e=document.querySelector(${literal(selector)});e.focus();e.value=${literal(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
}
async function click(root, selector) {
  await until(() => js(root, `Boolean(document.querySelector(${literal(selector)})&&!document.querySelector(${literal(selector)}).disabled)`), selector);
  return js(root, `document.querySelector(${literal(selector)}).click()`);
}
async function login(root, hub, email, password) {
  await until(async () => { const status=await rpc(root,'status'); return status.windowReady; }, 'production workspace');
  await until(() => js(root, `Boolean(document.querySelector('#soduWorkClientAuthGate')&&document.querySelector('[data-auth-mode=register]'))`), 'registration gate');
  await click(root, '[data-auth-mode=register]'); await fill(root, '#soduWorkAuthAccount', email); await click(root, '[data-send-code]');
  const challenge = await until(() => fs.existsSync(path.join(root, 'challenge.json')) && JSON.parse(fs.readFileSync(path.join(root, 'challenge.json'))).challengeId, 'email challenge');
  const code = await until(async () => {
    const response=await fetch(hub.url+'/__fixture__/mail/'+encodeURIComponent(challenge),{headers:{'X-Fixture-Key':hub.key}});
    const value=await response.json(); return value.ready && value.code;
  }, 'fixture mail delivery');
  await fill(root, '#acEmailCode', code); await fill(root, '#soduWorkAuthPassword', password); await fill(root, '#acConfirmPassword', password);
  await click(root, '#acConsent'); await click(root, '#soduWorkClientAuthGate [type=submit]');
  await until(() => js(root, `window.ClientAuth?.snapshot()?.state==='active' && ClientAuth.snapshot().user?.email===${literal(email)}`), 'authenticated production client', 60000);
}
async function startInference(root, providerURL) {
  const saved = await js(root, `(async()=>await soduWorkAPI.localModels.save({providers:[{id:'native-local',name:'Native local Qwen',baseUrl:${literal(providerURL+'/v1')},authMode:'none'}],models:[{providerId:'native-local',name:'native-qwen',label:'Native Qwen 0.6B',modality:'chat',ctxWindow:32768,config:{maxOutputTokens:2048}}]}))()`);
  assert.ok(saved.ok !== false, saved.reason || saved.error);
  const catalog=await js(root,'soduWorkAPI.localModels.get()');
  const payload=catalog.data || catalog.catalog || catalog;
  const model=payload.myModels?.[0]; assert.ok(model, 'Saved local model is not usable');
  const prompt='Native acceptance '+nonce+'. Write a long, detailed technical essay with at least 2000 words about reliable desktop application shutdown. Start writing immediately. Do not use tools.';
  const opened=await js(root,`soduWorkAPI.conversationSession.open({modelName:${literal(model.id||model.name)},cwd:${literal(JSON.parse(fs.readFileSync(path.join(root,'native-input.json'))).workspace)},adapterId:'pi'})`);
  assert.equal(opened.ok,true,opened.reason); assert.ok(opened.ref);
  await js(root,`(()=>{window.__nativeSendResult=null;window.__nativeSendPromise=soduWorkAPI.conversationSession.send(${literal(opened.ref)},${literal(prompt)},[],{}).then(value=>{window.__nativeSendResult=value},error=>{window.__nativeSendResult={error:String(error)}});return true})()`);
  await until(() => report.modelRequests.some(row=>row.acceptanceTask&&row.active&&row.status===200&&row.streamCharacters>0), 'real local inference stream', 120000);
  const events=eventRows(root); assert.ok(events.some(row=>row.event==='runtime-spawn'&&row.childPid),'Production utilityProcess did not start');
  return { sessionRef: opened.ref, modelRef: model.id || model.name };
}
async function quitDialog(root) {
  const status=await rpc(root,'status');
  await js(root,'(()=>{window.__nativeQuitPromise=soduWorkAPI.requestAppQuit().then(value=>{window.__nativeQuitResult=value},error=>{window.__nativeQuitResult={error:String(error)}});return true})()');
  return status;
}
async function armDelivery(root, app, kind, files) {
  const marker=path.join(root,'confirmed-quit.json');
  const ready=path.join(root,'native-delivery-ready');
  const values=files.map(file=>`(POSIX file ${literal(file)} as alias)`).join(',');
  const finder=files.length ? `tell application "Finder" to open {${values}} using (POSIX file ${literal(app)} as alias)\n` : '';
  const dock=kind==='dock'||kind==='mixed' ? 'tell application "System Events" to perform action "AXPress" of targetItem\n' : '';
  const setup=dock ? 'tell application "System Events" to tell process "Dock" to set targetItem to first UI element of list 1 whose description is "SoduWork"\n' : '';
  const script='use framework "Foundation"\n'+setup+'set fm to current application\'s NSFileManager\'s defaultManager()\n' +
    `do shell script "/usr/bin/touch " & quoted form of ${literal(ready)}\n` +
    `repeat 2000\nif (fm's fileExistsAtPath:${literal(marker)}) as boolean then\n${finder}${dock}return "native requests sent"\nend if\ndelay 0.005\nend repeat\nerror "Confirmed quit marker was not observed"`;
  const completion = apple(script,30000);
  // Compile Foundation and resolve the real Dock element before confirming
  // exit. This does not hold up or alter production shutdown.
  completion.catch(() => {});
  await until(() => fs.existsSync(ready), 'native delivery automation armed', 25000);
  return { completion };
}

(async()=>{
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const providerURL='http://127.0.0.1:'+proxy.address().port;
  for(const kind of ['cancel','finder','dock','mixed','budget']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-account-five-native-')));
    const workspace=path.join(root,'workspace'); fs.mkdirSync(workspace);
    const applications=path.join(root,'Applications'); fs.mkdirSync(applications);
    const app=path.join(applications,'SoduWork.app'); fs.cpSync(input.app,app,{recursive:true,verbatimSymlinks:true});
    fs.writeFileSync(path.join(applications,'native-root.txt'),root);
    nonce=crypto.randomUUID();
    const hub=await startHub(root);
    const filePaths=Array.from({length:kind==='budget'?25:2},(_,i)=>path.join(root,`材料 & ${i}.txt`));
    for(const file of filePaths)fs.writeFileSync(file,'Native Mac acceptance input.');
    const earlier=path.join(root,'earlier.txt');fs.writeFileSync(earlier,'Earlier startup file.');
    fs.writeFileSync(path.join(root,'native-input.json'),JSON.stringify({workspace,hub:hub.url,controlKey:crypto.randomBytes(24).toString('hex')}));
    const row={kind,root,ok:false,startedAt:Date.now()}; report.cases.push(row);flush();
    try{
      await execute('open',['-n','-a',app,'--args','--sodu-native-root',root,'--soduwork-open-file',earlier],{timeout:15000});
      await until(()=>fs.existsSync(path.join(root,'worker-control.json')),'installed client control');
      await login(root,hub,'native-'+nonce+'@example.test',crypto.randomBytes(18).toString('base64url'));
      const initial=await rpc(root,'status');row.oldPid=initial.pid;assert.equal(initial.packaged,true);assert.equal(initial.encryptionAvailable,true);
      const inferenceSession = await startInference(root,providerURL);row.realModelRunning=true;
      row.modelRef = inferenceSession.modelRef;
      await screenshot(root, kind, 'before-quit');
      const dialog=await quitDialog(root);
      await screenshot(root, kind, 'native-quit-dialog', true);
      if(kind==='cancel'){
        await nativeButton(initial.pid,dialog.cancelLabel);
        await nativeFiles([filePaths[0]],app);await nativeDock();
        await until(()=>eventRows(root).some(e=>e.event==='file-claim'&&e.name===path.basename(filePaths[0])),'file delivery after cancellation');
        const current=await rpc(root,'status');assert.equal(current.pid,initial.pid);assert.equal(current.quitting,false);
        assert.ok(!eventRows(root).some(e=>e.event==='confirmed-quit'||e.event==='relaunch'));
        row.modelStillRunningAfterCancellation = report.modelRequests.some(e => e.acceptanceTask && e.active && e.streamCharacters > 0);
        assert.equal(row.modelStillRunningAfterCancellation, true, 'Cancellation must leave the actual inference running');
        const finalDialog=await quitDialog(root);await nativeButton(initial.pid,finalDialog.quitLabel);
        await until(()=>eventRows(root).some(e=>e.event==='quit'&&e.pid===initial.pid),'normal confirmed exit');
      }else{
        const requested=kind==='dock'?[]:kind==='budget'?filePaths:kind==='finder'?[filePaths[0]]:[filePaths[0],filePaths[1],filePaths[0]];
        const delivery=await armDelivery(root,app,kind,requested);
        row.modelActiveBeforeConfirmation = report.modelRequests.some(e => e.acceptanceTask && e.active && e.streamCharacters > 0);
        assert.equal(row.modelActiveBeforeConfirmation, true, 'Real inference ended before confirmation');
        await nativeButton(initial.pid,dialog.quitLabel);await delivery.completion;
        await until(()=>eventRows(root).filter(e=>e.event==='process-start').length>=2,'fresh native relaunch',60000);
        const events=eventRows(root),marked=events.find(e=>e.event==='confirmed-quit'&&e.pid===initial.pid),boundary=events.find(e=>e.event==='will-quit'&&e.pid===initial.pid);
        assert.ok(marked&&boundary,'Actual confirmed-quit lifecycle was not observed');
        const inference = report.modelRequests.find(e => e.acceptanceTask && e.at <= marked.at &&
          (e.closedAt || e.endedAt || Date.now()) >= marked.at && e.streamCharacters > 0);
        assert.ok(inference, 'Confirmed quit did not overlap actual model execution');
        row.shutdownMilliseconds = boundary.at - marked.at;
        const received=events.filter(e=>e.pid===initial.pid&&e.quitting&&e.at>=marked.at&&e.at<=boundary.at);
        assert.ok(received.some(e=>e.event===(kind==='dock'?'activate':'open-file')),'Native requests did not reach the exiting process; case is untriggered');
        if(kind==='mixed')assert.ok(received.some(e=>e.event==='activate'),'Mixed Dock activation did not reach the exiting process');
        const relaunches=events.filter(e=>e.event==='relaunch'&&e.pid===initial.pid);assert.equal(relaunches.length,1);
        const expected=kind==='budget'?[...new Set(received.filter(e=>e.event==='open-file').map(e=>e.file))].slice(0,20):[...new Set(requested)];
        if(kind==='budget')assert.equal(expected.length,20,'Twenty-file native budget was not exercised');
        assert.deepEqual([...relaunches[0].files].sort(),[...expected].sort());
        const starts=events.filter(e=>e.event==='process-start');assert.equal(starts.length,2);row.newPid=starts[1].pid;assert.notEqual(row.newPid,initial.pid);
        assert.deepEqual([...starts[1].files].sort(),[...expected].sort());
        assert.ok(!received.some(e=>e.event==='window-show'&&/desk\.html/.test(e.url||'')),'Exiting workspace was revealed');
        const spawned=events.filter(e=>e.pid===initial.pid&&e.event==='runtime-spawn');
        assert.ok(spawned.every(e=>events.some(x=>x.pid===initial.pid&&x.event==='runtime-exit'&&x.childPid===e.childPid)),
          'Production utility processes did not report cleanup before relaunch');
        await until(()=>rpc(root,'status').then(s=>s.pid===row.newPid&&s.windowReady),'fresh production workspace');
        await until(()=>eventRows(root).filter(e=>e.pid===row.newPid&&e.event==='file-claim').length>=expected.length,'fresh native file claims',60000);
        const claims=eventRows(root).filter(e=>e.pid===row.newPid&&e.event==='file-claim');
        assert.deepEqual(claims.map(e=>e.name).sort(),expected.map(e=>path.basename(e)).sort());
        await until(() => js(root, `ClientAuth.snapshot().state==='active'&&ClientAuth.snapshot().user?.email===${literal('native-'+nonce+'@example.test')}`), 'existing authenticated profile after relaunch');
        const persisted = await js(root, 'soduWorkAPI.localModels.get()');
        assert.ok(persisted.myModels.some(model => model.id === inferenceSession.modelRef), 'Encrypted local model reference did not survive relaunch');
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'profile/hub-endpoint.json'))).hub, hub.url);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'profile/chat-config.json'))).workDir, workspace);
        row.profilePreserved = true;
        await screenshot(root, kind, 'after-relaunch');
        row.files=expected.map(e=>path.basename(e));row.nativeEvents=received;
        const finalDialog=await quitDialog(root);await nativeButton(row.newPid,finalDialog.quitLabel);
        await until(()=>eventRows(root).some(e=>e.event==='quit'&&e.pid===row.newPid),'fresh client exit');
      }
      const summary=await fetch(hub.url+'/__fixture__/summary',{headers:{'X-Fixture-Key':hub.key}}).then(r=>r.json());
      assert.equal(summary.modelCalls.length,0,'The Hub mock model was used instead of real local inference');
      row.ok=true;row.events=eventRows(root);flush();console.log('MACOS_NATIVE_CASE='+JSON.stringify({kind,ok:true,oldPid:row.oldPid,newPid:row.newPid,files:row.files}));
    }catch(error){row.error=String(error.stack||error);row.events=eventRows(root);report.errors.push(row.error);try{await screenshot(root,kind,'failure',true)}catch{}flush();throw error;}
    finally{
      for(const pid of [...new Set(eventRows(root).filter(e=>e.event==='process-start').map(e=>e.pid))]){try{process.kill(pid,'SIGTERM')}catch{}}
      try{await fetch(hub.url+'/__fixture__/shutdown',{method:'POST',headers:{'X-Fixture-Key':hub.key},signal:AbortSignal.timeout(5000)})}catch{hub.child.kill('SIGTERM')}
      // Every case shares the same retained DMG; remove only this generated
      // duplicate bundle after its owned processes exit to bound runner disk use.
      fs.rmSync(app, { recursive: true, force: true });
    }
  }
  report.ok=true;
})().catch(error=>{report.errors.push(String(error.stack||error));process.exitCode=1;}).finally(()=>{
  proxy.closeAllConnections();proxy.close();flush();console.log('MACOS_NATIVE_ACCEPTANCE_JSON='+JSON.stringify(report));
  for (const shot of report.screenshots) {
    console.log('MACOS_NATIVE_SCREENSHOT_JSON='+JSON.stringify({kind:shot.kind,name:shot.name,data:fs.readFileSync(path.join(output,shot.file)).toString('base64')}));
  }
});
