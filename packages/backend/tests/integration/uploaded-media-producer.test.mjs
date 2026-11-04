import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import { before, after, test } from 'node:test';
const W=fileURLToPath(new URL('../../../../',import.meta.url));
assert(process.env.TEST_DATABASE_URL);
Object.assign(process.env,{DATABASE_URL:process.env.TEST_DATABASE_URL,NODE_ENV:'test',JWT_SECRET:'owned-r33-qodo-jwt',COOKIE_SECRET:'owned-r33-qodo-cookie',LOG_LEVEL:'error'});
const storage=await mkdtemp(path.join(process.env.TMPDIR??os.tmpdir(),'producer-storage-'));process.env.STORAGE_DIR=storage;
const {buildApp}=await import(pathToFileURL(path.join(W,'packages/backend/src/app.ts')).href);
const {signAccessToken}=await import(pathToFileURL(path.join(W,'packages/backend/src/utils/tokens.ts')).href);
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const content=Buffer.from('Owned ordinary percent file');
const facts={cases:[],uploads:[]};let app,user,workspace,space,token,canonical,rawPercent,literalEscape,literalSlash,literalBackslash;let dispatches=0;
const save=()=>{};
async function record(name,fn){const row={name};facts.cases.push(row);try{await fn(row);row.status='PASS';}catch(error){row.status='FAIL';row.error={name:error.name,message:error.message};throw error;}finally{save();}}
async function upload(filename,bytes){
 const boundary='owned-'+crypto.randomUUID(),fields={workspaceId:workspace.id,purpose:'wiki',spaceId:space.id};
 const parts=Object.entries(fields).map(([key,value])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
 const payload=Buffer.concat([...parts,Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 const response=await app.inject({method:'POST',url:'/api/uploads',headers:{authorization:'Bearer '+token,'content-type':'multipart/form-data; boundary='+boundary},payload});
 assert.equal(response.statusCode,201,'Actual multipart producer prerequisite');const url=response.json().data.url;facts.uploads.push({filename,url,bytes:bytes.length});save();return url;
}
const read=url=>app.inject({method:'GET',url:'/api/uploads/media?'+new URLSearchParams({url}),headers:{authorization:'Bearer '+token}});
before(async()=>{
 app=await buildApp();app.addHook('onRequest',async(_request,reply)=>{const original=reply.sendFile;reply.sendFile=function(...args){dispatches++;return original.apply(this,args);};});await app.ready();
 const suffix=crypto.randomUUID();user=await app.prisma.user.create({data:{email:`r33-producer-${suffix}@example.test`,displayName:'Owned producer'}});
 workspace=await app.prisma.workspace.create({data:{name:'Owned producer',slug:'r33-producer-'+suffix,members:{create:{userId:user.id,role:'ADMIN'}}}});
 space=await app.prisma.wikiSpace.create({data:{name:'Producer',slug:'producer',workspaceId:workspace.id}});token=signAccessToken({sub:user.id,email:user.email});
 canonical=await upload('owned.gif',gif);rawPercent=await upload('progress.100%',content);literalEscape=await upload('literal.x%20',content);literalSlash=await upload('literal.x%2F',content);literalBackslash=await upload('literal.x%5C',content);
 assert(rawPercent.endsWith('.100%')&&literalEscape.endsWith('.x%20'),'Producer retains opaque actual extension');
});
test('raw percent producer roundtrip',()=>record('raw-percent',async row=>{const wire='/api/uploads/media?'+new URLSearchParams({url:rawPercent});row.wirePercentEncoded=wire.includes('%25');assert(row.wirePercentEncoded);const r=await read(rawPercent);row.http=r.statusCode;row.bodySHA=crypto.createHash('sha256').update(r.rawPayload).digest('hex');assert.equal(r.statusCode,200);assert.deepEqual(r.rawPayload,content);assert.match(r.headers['content-type'],/^application\/octet-stream/);assert.match(r.headers['content-disposition'],/^attachment/);}));
test('literal percent escape is not decoded into a different filename',()=>record('literal-percent-escape',async row=>{const r=await read(literalEscape);row.http=r.statusCode;assert.equal(r.statusCode,200);assert.deepEqual(r.rawPayload,content);}));
test('ordinary canonical producer control',()=>record('canonical-control',async row=>{const r=await read(canonical);row.http=r.statusCode;assert.equal(r.statusCode,200);assert.deepEqual(r.rawPayload,gif);}));
test('encoded structural separator remains refused control',()=>record('separator-control',async row=>{const count=dispatches,r=await read(canonical.replace('/uploads/','/uploads%2f'));row.http=r.statusCode;row.dispatchDelta=dispatches-count;assert.equal(r.statusCode,400);assert.equal(row.dispatchDelta,0);}));
for(const [name,reference] of [['slash',()=>literalSlash],['backslash',()=>literalBackslash]])test('literal encoded '+name+' filename remains opaque',()=>record('literal-'+name,async row=>{const ref=reference();assert(ref.endsWith(name==='slash'?'.x%2F':'.x%5C'));const r=await read(ref);row.http=r.statusCode;row.url=ref;assert.equal(r.statusCode,200);assert.deepEqual(r.rawPayload,content);assert.match(r.headers['content-type'],/^application\/octet-stream/);assert.match(r.headers['content-disposition'],/^attachment/);}));
after(async()=>{
 try{if(app){if(workspace)await app.prisma.workspace.deleteMany({where:{id:workspace.id}});if(user)await app.prisma.user.deleteMany({where:{id:user.id}});}}finally{await app?.close();await rm(storage,{recursive:true,force:true});facts.cleanupFinished=true;save();}
});
