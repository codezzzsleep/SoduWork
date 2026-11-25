'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const files=require('../main/app-files.cjs'),settings=require('../main/app-settings-store.cjs');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-file-delete-')),app={getPath:()=>root};
  const binding={pluginId:'local:delete-'+crypto.randomUUID(),origin:'https://file-delete.invalid'};
  let owner='account-a';const uploads=[];
  settings.configure({app,ownerOf:()=>owner});
  const call=(method,params,guard=()=>{},options={})=>files.execute(app,binding,method,params,guard,options);
  t.after(async()=>{
    owner='account-a';
    for(const id of uploads)try{await call('files.cancel',{id});}catch(_){}
    settings.configure(undefined);fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,app,binding,uploads,call,owner:value=>{owner=value;}};
}
async function upload(f,projectId='project',bytes=Buffer.from('original project bytes')) {
  const start=await f.call('files.begin',{projectId,name:'original.png',type:'image/png',size:bytes.length});
  f.uploads.push(start.id);
  if(bytes.length)await f.call('files.append',{id:start.id,offset:0,data:bytes});
  const {file}=await f.call('files.finish',{id:start.id});
  return {start,file,bytes};
}
function pair(f,file) {
  const all=fs.readdirSync(path.join(f.root,'jiyong-files'),{recursive:true});
  const meta=all.find(name=>path.basename(String(name))===file.id+'.json');
  assert.ok(meta);const metadata=path.join(f.root,'jiyong-files',String(meta));
  return {metadata,binary:path.join(path.dirname(metadata),file.id+'.png')};
}
test('scoped deletion removes only a committed pair and makes old URL and finish receipts unusable',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file);
  assert.equal((await f.call('files.finish',{id:saved.start.id})).file.id,saved.file.id);
  assert.deepEqual(await f.call('files.delete',{projectId:'project',id:saved.file.id}),{ok:true,deleted:true});
  assert.equal(fs.existsSync(paths.metadata),false);assert.equal(fs.existsSync(paths.binary),false);
  await assert.rejects(f.call('files.getUrl',{projectId:'project',id:saved.file.id}));
  await assert.rejects(files.response(f.app,f.binding,{url:saved.file.url,method:'GET',headers:{'if-none-match':'"'+saved.file.sha256+'"'}}));
  await assert.rejects(f.call('files.finish',{id:saved.start.id}),/不存在|取消/);
  assert.deepEqual(await f.call('files.delete',{projectId:'project',id:saved.file.id}),{ok:true,deleted:false});
});
test('deletion preserves other accounts, apps and projects',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file);
  assert.equal((await f.call('files.delete',{projectId:'other-project',id:saved.file.id})).deleted,false);
  assert.equal((await files.execute(f.app,{...f.binding,pluginId:'local:other-app'},'files.delete',{projectId:'project',id:saved.file.id})).deleted,false);
  f.owner('account-b');
  assert.equal((await f.call('files.delete',{projectId:'project',id:saved.file.id})).deleted,false);
  f.owner('account-a');
  assert.deepEqual(fs.readFileSync(paths.binary),saved.bytes);
  assert.equal((await f.call('files.getUrl',{projectId:'project',id:saved.file.id})).file.id,saved.file.id);
});
test('deletion rejects paths, upload IDs and extra fields without changing the saved pair',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file),before=fs.readFileSync(paths.metadata);
  for(const params of [
    {projectId:'project',id:'../../outside'},
    {projectId:'project',id:saved.start.id},
    {projectId:'project',id:saved.file.id,path:paths.binary},
    {projectId:'',id:saved.file.id},
  ])await assert.rejects(f.call('files.delete',params));
  assert.deepEqual(fs.readFileSync(paths.metadata),before);assert.deepEqual(fs.readFileSync(paths.binary),saved.bytes);
});
test('deletion preserves unfinished uploads and unrecognized neighboring files',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file);
  const active=await f.call('files.begin',{projectId:'project',name:'pending.png',type:'image/png',size:3});f.uploads.push(active.id);
  const unrelated=path.join(path.dirname(paths.binary),'unrecognized.bin');fs.writeFileSync(unrelated,'keep');
  await f.call('files.delete',{projectId:'project',id:saved.file.id});
  assert.equal(fs.readFileSync(unrelated,'utf8'),'keep');
  await f.call('files.append',{id:active.id,offset:0,data:Buffer.from('new')});
  const result=await f.call('files.finish',{id:active.id});
  assert.equal(result.file.size,3);
});
test('a failed binary unlink retains the file, metadata and successful upload receipt',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file),unlink=fsp.unlink;
  fsp.unlink=async file=>{if(file===paths.binary)throw Object.assign(Error('controlled unlink refusal'),{code:'EACCES'});return unlink(file);};
  try{await assert.rejects(f.call('files.delete',{projectId:'project',id:saved.file.id}),{code:'EACCES'});}
  finally{fsp.unlink=unlink;}
  assert.deepEqual(fs.readFileSync(paths.binary),saved.bytes);assert.equal(fs.existsSync(paths.metadata),true);
  assert.equal((await f.call('files.finish',{id:saved.start.id})).file.id,saved.file.id);
  assert.equal((await f.call('files.delete',{projectId:'project',id:saved.file.id})).deleted,true);
});
test('metadata unlink failure reports failure and supports explicit recovery after bytes are removed',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file),unlink=fsp.unlink;
  fsp.unlink=async file=>{if(file===paths.metadata)throw Object.assign(Error('controlled metadata refusal'),{code:'EACCES'});return unlink(file);};
  try{await assert.rejects(f.call('files.delete',{projectId:'project',id:saved.file.id}),{code:'EACCES'});}
  finally{fsp.unlink=unlink;}
  assert.equal(fs.existsSync(paths.binary),false);assert.equal(fs.existsSync(paths.metadata),true);
  await assert.rejects(f.call('files.finish',{id:saved.start.id}),/不存在|取消/);
  await assert.rejects(f.call('files.getUrl',{projectId:'project',id:saved.file.id}));
  assert.equal((await f.call('files.delete',{projectId:'project',id:saved.file.id})).deleted,true);
  assert.equal(fs.existsSync(paths.metadata),false);
});
test('concurrent deletion requests reuse one operation instead of unlinking the pair twice',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file),unlink=fsp.unlink;
  let release,entered,bytesCalls=0,metaCalls=0;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  fsp.unlink=async file=>{
    if(file===paths.binary){bytesCalls++;entered();await gate;}
    if(file===paths.metadata)metaCalls++;
    return unlink(file);
  };
  try{
    const first=f.call('files.delete',{projectId:'project',id:saved.file.id});await ready;
    const second=f.call('files.delete',{projectId:'project',id:saved.file.id});release();
    const results=await Promise.all([first,second]);
    assert.ok(results.every(result=>result.ok&&result.deleted));
    assert.equal(bytesCalls,1);assert.equal(metaCalls,1);
  }finally{release();fsp.unlink=unlink;}
});
test('a changed account during metadata access stops before removing any bytes',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file),lstat=fsp.lstat;
  fsp.lstat=async file=>{const result=await lstat(file);if(file===paths.metadata)f.owner('account-b');return result;};
  try{await assert.rejects(f.call('files.delete',{projectId:'project',id:saved.file.id}),/账号已变化/);}
  finally{fsp.lstat=lstat;f.owner('account-a');}
  assert.deepEqual(fs.readFileSync(paths.binary),saved.bytes);assert.equal(fs.existsSync(paths.metadata),true);
});
test('a revoked current authorization stops deletion without touching the pair',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file);let checks=0;
  await assert.rejects(f.call('files.delete',{projectId:'project',id:saved.file.id},()=>{
    if(++checks===2)throw Error('controlled current permission revocation');
  }),/permission revocation/);
  assert.deepEqual(fs.readFileSync(paths.binary),saved.bytes);assert.equal(fs.existsSync(paths.metadata),true);
});
test('copied-file deletion preserves the original and invalidates its native-copy cache',async t=>{
  const f=fixture(t),original=path.join(f.root,'selected-original.png');
  fs.copyFileSync(path.resolve(__dirname,'../assets/rail-icons/skills.png'),original);const bytes=fs.readFileSync(original);
  const selected=await f.call('files.pickLocal',{},()=>{},{dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[original]})}});
  const params={projectId:'project',sourceId:selected.items[0].sourceId},first=await f.call('files.copyLocal',params);
  assert.equal((await f.call('files.copyLocal',params)).file.id,first.file.id);
  await f.call('files.delete',{projectId:'project',id:first.file.id});
  const second=await f.call('files.copyLocal',params);
  assert.notEqual(second.file.id,first.file.id);assert.deepEqual(fs.readFileSync(original),bytes);
  assert.deepEqual(Buffer.from(await(await files.response(f.app,f.binding,{url:second.file.url,method:'GET'})).arrayBuffer()),bytes);
});
test('deletion refuses linked metadata or binary files rather than following them',async t=>{
  const f=fixture(t),original=path.join(f.root,'unrelated-original');fs.writeFileSync(original,'protected');
  for(const kind of ['metadata','binary']){
    const saved=await upload(f,kind),paths=pair(f,saved.file),chosen=paths[kind];
    fs.unlinkSync(chosen);fs.symlinkSync(original,chosen);
    await assert.rejects(f.call('files.delete',{projectId:kind,id:saved.file.id}),/文件记录无效|文件缺失/);
    assert.equal(fs.readFileSync(original,'utf8'),'protected');
  }
});
test('an unrecognized orphan is preserved and the public bridge still rejects this private prototype method',async t=>{
  const f=fixture(t),saved=await upload(f),paths=pair(f,saved.file),orphan='file_'+'a'.repeat(32);
  const file=path.join(path.dirname(paths.binary),orphan+'.png');fs.writeFileSync(file,'unregistered');
  assert.equal((await f.call('files.delete',{projectId:'project',id:orphan})).deleted,false);
  assert.equal(fs.readFileSync(file,'utf8'),'unregistered');
  assert.equal(require('../main/soduwork-app-bridge-contract.cjs').METHODS.has('files.delete'),false);
});
