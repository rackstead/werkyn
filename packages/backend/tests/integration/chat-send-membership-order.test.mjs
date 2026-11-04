import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
if (!process.env.TEST_DATABASE_URL) throw Error("Set TEST_DATABASE_URL to an owned disposable PostgreSQL database");
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';
process.env.JWT_SECRET='owned-chat-send-order-jwt';process.env.COOKIE_SECRET='owned-chat-send-order-cookie';
const base=new URL(process.env.TEST_DATABASE_URL);base.searchParams.set('connection_limit','1');
const require=createRequire(import.meta.url);const {PrismaClient}=require('@prisma/client');
const chat=await import('../../src/modules/chat/chat.service.js');
const workspaceService=await import('../../src/modules/workspaces/workspaces.service.js');
const {isRetryableDatabaseError}=await import('../../src/utils/retryable-database-errors.js');
const facts=[];const save=()=>process.env.R30_ORDER_FACTS&&fs.writeFileSync(process.env.R30_ORDER_FACTS,JSON.stringify(facts,null,2)+'\n',{mode:0o600});
function client(){return new PrismaClient({datasources:{db:{url:base.href}}})}
function latch(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned prerequisite deadline: '+label)),ms)})])}finally{clearTimeout(timer)}}
async function setup(type='PRIVATE'){
 const db=client(),id=crypto.randomUUID(),owned={id,db,others:[]};
 try{
  owned.admin=await db.user.create({data:{email:'r30-admin-'+id+'@example.test',displayName:'Owned order admin'}});
  owned.sender=await db.user.create({data:{email:'r30-sender-'+id+'@example.test',displayName:'Owned order sender'}});
  owned.workspace=await db.workspace.create({data:{name:'Owned R30 order',slug:'r30-order-'+id,members:{create:[{userId:owned.admin.id,role:'ADMIN'},{userId:owned.sender.id,role:'MEMBER'}]}}});
  owned.channel=await db.chatChannel.create({data:{workspaceId:owned.workspace.id,type,name:type==='DM'?null:'Owned order',createdById:owned.admin.id,members:{create:[{userId:owned.admin.id},{userId:owned.sender.id}]}}});return owned;
 }catch(error){await cleanup(owned);throw error}
}
async function cleanup(f){try{if(f.workspace)await f.db.workspace.deleteMany({where:{id:f.workspace.id}});const ids=[f.admin?.id,f.sender?.id].filter(Boolean);if(ids.length)await f.db.user.deleteMany({where:{id:{in:ids}}})}finally{await Promise.allSettled(f.others.map(p=>p.$disconnect()));await f.db.$disconnect()}}
async function snapshot(f,content){return {channel:await f.db.chatChannel.findUnique({where:{id:f.channel.id},select:{updatedAt:true}}),messages:await f.db.chatMessage.count({where:{channelId:f.channel.id,content}}),subscriptions:await f.db.chatThreadSubscription.count({where:{userId:f.sender.id}}),outbox:await f.db.chatMessageDelivery.count({where:{message:{channelId:f.channel.id,content}}}),notifications:await f.db.notification.count({where:{userId:{in:[f.admin.id,f.sender.id]}}})}}
async function observeOwnedWait(monitor,senderPid,blockerPid){const until=Date.now()+1800;while(Date.now()<until){const rows=await monitor.$queryRaw`SELECT pid, state, wait_event_type AS "waitEventType", wait_event AS "waitEvent", pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${senderPid} AND datname=current_database()`;if(rows[0]?.waitEventType==='Lock'&&rows[0].blockers.includes(blockerPid))return rows[0];await new Promise(r=>setTimeout(r,15))}throw Error('Owned prerequisite: send was not observed waiting on its exact channel blocker')}
async function removalWins(kind){
 const f=await setup(kind==='workspace-dm'?'DM':'PRIVATE');const row={case:kind,ownedWorkspaceId:f.workspace.id,ownedChannelId:f.channel.id,events:[]};facts.push(row);save();const gate=latch(),held=latch();let gateTask,sendTask,removalTask;const content='Owned R30 ordering '+f.id;const key=kind==='workspace-dm'?undefined:'r30-'+f.id;
 try{
  if(kind==='demotion')f.parent=await f.db.chatMessage.create({data:{channelId:f.channel.id,userId:f.admin.id,content:'Owned thread parent'}});
  const before=await snapshot(f,content);row.before=before;
  const blocker=client(),sender=client();f.others.push(blocker,sender);const [{pid:senderPid}]=await sender.$queryRaw`SELECT pg_backend_pid() AS pid`;let blockerPid;
  gateTask=blocker.$transaction(async tx=>{[{pid:blockerPid}]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;await tx.$queryRaw`SELECT id FROM "ChatChannel" WHERE id=${f.channel.id} FOR UPDATE`;row.events.push({kind:'owned-channel-gate-held',blockerPid,senderPid});save();held.resolve();await gate.promise},{timeout:5000,maxWait:2000});void gateTask.catch(()=>{});await bounded(held.promise,1200,'channel gate held');
  sendTask=chat.sendMessage(sender,f.channel.id,f.sender.id,content,f.parent?.id,key).then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error:{name:error.name,statusCode:error.statusCode,message:error.message,code:error.code}}));
  row.wait=await observeOwnedWait(f.db,senderPid,blockerPid);row.events.push({kind:'real-send-lock-wait-observed'});save();
  removalTask=kind==='channel'?chat.removeMembers(f.db,f.channel.id,f.admin.id,'ADMIN',f.sender.id):kind==='workspace-dm'?workspaceService.removeMember(f.db,f.workspace.id,f.sender.id,f.admin.id,'ADMIN'):workspaceService.updateMemberRole(f.db,f.workspace.id,f.sender.id,f.admin.id,{role:'VIEWER'});
  await bounded(removalTask,1400,'real membership writer commit');row.events.push({kind:'real-membership-writer-committed-before-gate-release'});
  row.afterMembership={workspace:await f.db.workspaceMember.findUnique({where:{userId_workspaceId:{userId:f.sender.id,workspaceId:f.workspace.id}},select:{role:true}}),channel:await f.db.chatChannelMember.findUnique({where:{channelId_userId:{channelId:f.channel.id,userId:f.sender.id}},select:{id:true}})};
  if(kind==='workspace-dm'){assert.equal(row.afterMembership.workspace,null);assert.ok(row.afterMembership.channel,'Current intentional retained DM membership prerequisite')}
  if(kind==='demotion')assert.equal(row.afterMembership.workspace.role,'VIEWER');
  row.events.push({kind:'owned-channel-gate-release'});save();gate.resolve();await gateTask;row.send=await bounded(sendTask,1800,'send settlement');row.events.push({kind:'real-send-settled'});row.after=await snapshot(f,content);save();
  assert.equal(row.send.status,'rejected','Membership writer committed before send admission: refuse rather than commit a message');assert.equal(row.send.error.statusCode,403);assert.deepEqual(row.after,before,'Denied send commits no channel timestamp/message/subscription/outbox/notification side effects');
 }finally{gate.resolve();await Promise.allSettled([gateTask,sendTask,removalTask].filter(Boolean));await cleanup(f);row.events.push({kind:'owned-fixtures-disconnected-and-removed'});save()}
}
test('R30 channel removal committed before send admission refuses without writes',()=>removalWins('channel'));
test('R30 workspace removal with retained DM membership refuses without writes',()=>removalWins('workspace-dm'));
test('R30 viewer demotion committed before reply admission refuses without writes',()=>removalWins('demotion'));
test('R30 current joined member ordinary send control stores one message and outbox',async()=>{const f=await setup();const row={case:'allowed-control'};facts.push(row);try{const content='Owned allowed '+f.id;row.before=await snapshot(f,content);const result=await chat.sendMessage(f.db,f.channel.id,f.sender.id,content);row.after=await snapshot(f,content);row.result={id:result.message.id,replayed:result.replayed};save();assert.equal(result.replayed,false);assert.equal(row.after.messages,1);assert.equal(row.after.outbox,1);assert.equal(row.after.subscriptions,0);assert.equal(row.after.notifications,0)}finally{await cleanup(f);row.cleaned=true;save()}});
test('R30 already absent channel member denial control has zero send writes',async()=>{const f=await setup('PUBLIC');const row={case:'absent-control'};facts.push(row);try{await chat.leaveChannel(f.db,f.channel.id,f.sender.id);const content='Owned absent '+f.id;row.before=await snapshot(f,content);await assert.rejects(chat.sendMessage(f.db,f.channel.id,f.sender.id,content),e=>e.statusCode===403);row.after=await snapshot(f,content);save();assert.deepEqual(row.after,row.before)}finally{await cleanup(f);row.cleaned=true;save()}});

function outcome(promise){return promise.then(value=>({status:'fulfilled',value}),error=>({status:'rejected',error}))}
async function installOutboxGate(f,content,key,{reject=false}={}){
 const name='r30_order_'+f.id.replaceAll('-','');assert.match(name,/^[a-z0-9_]+$/);assert.match(content,/^[A-Za-z0-9 -]+$/);
 const fn='"'+name+'"',literal="'"+content+"'";
 await f.db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "ChatMessage" WHERE id=NEW."messageId" AND content=${literal}) THEN ${reject?"RAISE EXCEPTION 'owned order rollback';":`PERFORM pg_advisory_xact_lock(${key});`} END IF; RETURN NEW; END $$`);
 try{await f.db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "ChatMessageDelivery" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)}catch(error){await f.db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);throw error}
 return async()=>{await f.db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "ChatMessageDelivery"`);await f.db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)};
}
async function holdOutbox(f,content,clientKey){
 const gate=latch(),held=latch(),key=crypto.randomInt(1000000,2000000000);let remove,gateTask,sending;
 try{
  remove=await installOutboxGate(f,content,key);const blocker=client(),sender=client();f.others.push(blocker,sender);
  let blockerPid;const [{pid:senderPid}]=await sender.$queryRaw`SELECT pg_backend_pid() AS pid`;
  gateTask=blocker.$transaction(async tx=>{[{pid:blockerPid}]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;held.resolve();await gate.promise},{timeout:5000,maxWait:2000});void gateTask.catch(()=>{});await bounded(held.promise,1200,'owned outbox gate');
  sending=outcome(chat.sendMessage(sender,f.channel.id,f.sender.id,content,undefined,clientKey));await observeOwnedWait(f.db,senderPid,blockerPid);
  return {senderPid,sending,gateTask,release:()=>gate.resolve(),remove};
 }catch(error){gate.resolve();await Promise.allSettled([gateTask,sending].filter(Boolean));if(remove)await remove();throw error}
}

async function sendWins(kind){
 const f=await setup(kind==='workspace'?'DM':'PRIVATE'),content='Owned send wins '+f.id;let gate,writing;
 const row={case:'send-wins-'+kind};facts.push(row);save();
 try{
  gate=await holdOutbox(f,content);const actor=client();f.others.push(actor);const [{pid:writerPid}]=await actor.$queryRaw`SELECT pg_backend_pid() AS pid`;
  const work=kind==='channel'?chat.removeMembers(actor,f.channel.id,f.admin.id,'ADMIN',f.sender.id):kind==='workspace'?workspaceService.removeMember(actor,f.workspace.id,f.sender.id,f.admin.id,'ADMIN'):kind==='role'?workspaceService.updateMemberRole(actor,f.workspace.id,f.sender.id,f.admin.id,{role:'VIEWER'}):kind==='channel-delete'?chat.deleteChannel(actor,f.channel.id,f.admin.id,'ADMIN'):workspaceService.deleteWorkspace(actor,f.workspace.id);
  writing=outcome(work);row.wait=await observeOwnedWait(f.db,writerPid,gate.senderPid);save();gate.release();await gate.gateTask;row.send=await bounded(gate.sending,1800,'admitted send commit');row.writer=await bounded(writing,1800,'writer after admitted send');assert.equal(row.send.status,'fulfilled');assert.equal(row.writer.status,'fulfilled');assert.equal(row.send.value.replayed,false);
  if(kind==='channel-delete'||kind==='workspace-delete')assert.equal(await f.db.chatChannel.findUnique({where:{id:f.channel.id}}),null);
  else{row.after=await snapshot(f,content);assert.equal(row.after.messages,1);assert.equal(row.after.outbox,1);if(kind==='role')assert.equal((await f.db.workspaceMember.findUnique({where:{userId_workspaceId:{userId:f.sender.id,workspaceId:f.workspace.id}}})).role,'VIEWER');else assert.equal(await f.db.workspaceMember.count({where:{userId:f.sender.id,workspaceId:f.workspace.id}}),kind==='workspace'?0:1)}save();
 }finally{gate?.release();await Promise.allSettled([gate?.gateTask,gate?.sending,writing].filter(Boolean));if(gate)await gate.remove();await cleanup(f);row.cleaned=true;save()}
}
test('R30 admitted send holds channel membership until commit before removal',()=>sendWins('channel'));
test('R30 admitted DM send commits before workspace removal',()=>sendWins('workspace'));
test('R30 admitted send commits before viewer demotion',()=>sendWins('role'));
test('R30 concurrent keyed requests retain exactly-one storage and private key omission',async()=>{
 const f=await setup();try{const key='same-'+f.id,content='Owned keyed '+f.id;const pair=await Promise.all([chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,key),chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,key)]);assert.equal(pair[0].message.id,pair[1].message.id);assert.deepEqual(pair.map(r=>r.replayed).sort(),[false,true]);for(const r of pair){assert.equal(Object.hasOwn(r.message,'clientMessageId'),false);assert.equal(Object.hasOwn(r.message,'clientMessageHash'),false)}const state=await snapshot(f,content);assert.equal(state.messages,1);assert.equal(state.outbox,1);await assert.rejects(chat.sendMessage(f.db,f.channel.id,f.sender.id,'Different request',undefined,key),e=>e.statusCode===409);const unkeyed='Owned unkeyed '+f.id;await Promise.all([chat.sendMessage(f.db,f.channel.id,f.sender.id,unkeyed),chat.sendMessage(f.db,f.channel.id,f.sender.id,unkeyed)]);assert.equal((await snapshot(f,unkeyed)).messages,2)}finally{await cleanup(f)}
});
test('R30 archived channel denies new sends but preserves matching authorized replay',async()=>{const f=await setup();try{const key='archive-'+f.id,content='Owned before archive '+f.id,first=await chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,key);await chat.archiveChannel(f.db,f.channel.id,f.admin.id,'ADMIN',true);const before=await snapshot(f,content);const replay=await chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,key);assert.equal(replay.replayed,true);assert.equal(replay.message.id,first.message.id);assert.deepEqual(await snapshot(f,content),before);await assert.rejects(chat.sendMessage(f.db,f.channel.id,f.sender.id,'Owned after archive '+f.id),e=>e.statusCode===403)}finally{await cleanup(f)}});
test('R30 matching keyed replay is refused after channel removal',async()=>{const f=await setup();try{const key='removed-'+f.id,content='Owned replay '+f.id;await chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,key);await chat.removeMembers(f.db,f.channel.id,f.admin.id,'ADMIN',f.sender.id);const before=await snapshot(f,content);await assert.rejects(chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,key),e=>e.statusCode===403);assert.deepEqual(await snapshot(f,content),before)}finally{await cleanup(f)}});
test('R30 invalid reply and outbox rollback release admission with no partial send writes',async()=>{
 const f=await setup();let remove;try{const invalid='Owned invalid reply '+f.id,before=await snapshot(f,invalid);await assert.rejects(chat.sendMessage(f.db,f.channel.id,f.sender.id,invalid,'missing-parent'),e=>e.statusCode===404);assert.deepEqual(await snapshot(f,invalid),before);const content='Owned rollback '+f.id,rollbackBefore=await snapshot(f,content);remove=await installOutboxGate(f,content,0,{reject:true});await assert.rejects(chat.sendMessage(f.db,f.channel.id,f.sender.id,content,undefined,'rollback-'+f.id));assert.deepEqual(await snapshot(f,content),rollbackBefore);await bounded(chat.removeMembers(f.db,f.channel.id,f.admin.id,'ADMIN',f.sender.id),1400,'membership locks released after rollback');assert.equal(await f.db.chatChannelMember.count({where:{channelId:f.channel.id,userId:f.sender.id}}),0)}finally{if(remove)await remove();await cleanup(f)}
});
test('R30 unrelated channel send progresses while an admitted send in the same workspace is held',async()=>{
 const f=await setup();let gate;try{const other=await f.db.chatChannel.create({data:{workspaceId:f.workspace.id,name:'Other owned channel',createdById:f.admin.id,members:{create:{userId:f.sender.id}}}});gate=await holdOutbox(f,'Owned held channel '+f.id);const result=await bounded(chat.sendMessage(f.db,other.id,f.sender.id,'Owned other channel '+f.id),1400,'no workspace-wide send mutex');assert.equal(result.replayed,false);gate.release();await gate.gateTask;assert.equal((await gate.sending).status,'fulfilled')}finally{gate?.release();await Promise.allSettled([gate?.gateTask,gate?.sending].filter(Boolean));if(gate)await gate.remove();await cleanup(f)}
});
test('R30 admitted send settles before channel deletion enters its membership cascade',()=>sendWins('channel-delete'));
test('R30 admitted send settles before workspace deletion enters its child cascade',()=>sendWins('workspace-delete'));
test('R30 user-delete cascade cycle rolls one transaction back without a partial send',async()=>{
 const f=await setup(),name='r30_user_'+f.id.replaceAll('-',''),key=crypto.randomInt(1000000,2000000000),gate=latch(),held=latch();let gateTask,deleting,sending,installed=false;const row={case:'user-cascade-rollback'};facts.push(row);
 try{
  assert.match(name,/^[a-z0-9_]+$/);assert.match(f.sender.id,/^[a-z0-9]+$/);await f.db.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${f.sender.id}' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN OLD; END $$`);await f.db.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION "${name}"()`);installed=true;
  const blocker=client(),deleter=client(),sender=client();f.others.push(blocker,deleter,sender);let blockerPid;const [{pid:deletePid}]=await deleter.$queryRaw`SELECT pg_backend_pid() AS pid`;const [{pid:sendPid}]=await sender.$queryRaw`SELECT pg_backend_pid() AS pid`;
  gateTask=blocker.$transaction(async tx=>{[{pid:blockerPid}]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;held.resolve();await gate.promise},{timeout:5000,maxWait:2000});void gateTask.catch(()=>{});await bounded(held.promise,1200,'user-delete gate');deleting=outcome(deleter.user.delete({where:{id:f.sender.id}}));row.deleteWait=await observeOwnedWait(f.db,deletePid,blockerPid);
  const content='Owned cascade '+f.id;sending=outcome(chat.sendMessage(sender,f.channel.id,f.sender.id,content));row.sendWait=await observeOwnedWait(f.db,sendPid,deletePid);save();gate.resolve();await gateTask;const [sent,deleted]=await Promise.all([sending,deleting]);row.send=sent.status;row.deleted=deleted.status;assert.equal([sent,deleted].filter(r=>r.status==='rejected').length,1);const rejected=[sent,deleted].find(r=>r.status==='rejected');assert.ok(isRetryableDatabaseError(rejected.error),'Existing deadlock/transaction-abandonment 409 classifier');const after=await snapshot(f,content);row.after=after;if(sent.status==='rejected'){assert.equal(after.messages,0);assert.equal(after.outbox,0);assert.equal(after.subscriptions,0)}else{assert.equal(deleted.status,'rejected');assert.equal(after.messages,1);assert.equal(after.outbox,1)}save();
 }finally{gate.resolve();await Promise.allSettled([gateTask,deleting,sending].filter(Boolean));if(installed){await f.db.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "User"`);await f.db.$executeRawUnsafe(`DROP FUNCTION "${name}"()`)}await cleanup(f);row.cleaned=true;save()}
});
test('R30 admission preserves a stricter connection statement deadline and restores local settings',async()=>{
 const f=await setup(),gate=latch(),held=latch();let gateTask,sending;try{const blocker=client();const limitedUrl=new URL(base);limitedUrl.searchParams.set('options','-c statement_timeout=75 -c lock_timeout=75');const sender=new PrismaClient({datasources:{db:{url:limitedUrl.href}}});f.others.push(blocker,sender);gateTask=blocker.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "ChatChannel" WHERE id=${f.channel.id} FOR UPDATE`;held.resolve();await gate.promise},{timeout:5000,maxWait:2000});void gateTask.catch(()=>{});await bounded(held.promise,1200,'strict limit gate');const before=await snapshot(f,'Owned bounded '+f.id);sending=outcome(chat.sendMessage(sender,f.channel.id,f.sender.id,'Owned bounded '+f.id));const result=await bounded(sending,1400,'stricter server bound');assert.equal(result.status,'rejected');assert.equal(result.error.statusCode,409);assert.deepEqual(await snapshot(f,'Owned bounded '+f.id),before);gate.resolve();await gateTask;const settings=await sender.$queryRaw`SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;assert.deepEqual(settings,[{statement:'75ms',lock:'75ms'}])}finally{gate.resolve();await Promise.allSettled([gateTask,sending].filter(Boolean));await cleanup(f)}
});
test('R30 different channels racing one author key preserve conflict and no loser writes',async()=>{
 const f=await setup(),key='cross-channel-'+f.id;let gate,loser;try{const other=await f.db.chatChannel.create({data:{workspaceId:f.workspace.id,name:'Owned conflicting channel',createdById:f.admin.id,members:{create:{userId:f.sender.id}}}});const before=await f.db.chatChannel.findUnique({where:{id:other.id},select:{updatedAt:true}});gate=await holdOutbox(f,'Owned winner '+f.id,key);const sender=client();f.others.push(sender);const [{pid}]=await sender.$queryRaw`SELECT pg_backend_pid() AS pid`;loser=outcome(chat.sendMessage(sender,other.id,f.sender.id,'Owned different channel '+f.id,undefined,key));await observeOwnedWait(f.db,pid,gate.senderPid);gate.release();await gate.gateTask;assert.equal((await gate.sending).status,'fulfilled');const result=await loser;assert.equal(result.status,'rejected');assert.equal(result.error.statusCode,409);assert.equal(await f.db.chatMessage.count({where:{channelId:other.id}}),0);assert.equal(await f.db.chatMessageDelivery.count({where:{message:{channelId:other.id}}}),0);assert.deepEqual(await f.db.chatChannel.findUnique({where:{id:other.id},select:{updatedAt:true}}),before)}finally{gate?.release();await Promise.allSettled([gate?.gateTask,gate?.sending,loser].filter(Boolean));if(gate)await gate.remove();await cleanup(f)}
});
