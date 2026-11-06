import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { hashPassword, verifyLoginPassword, verifyPassword } from "../src/utils/passwords.ts";
import { logger } from "../src/utils/logger.ts";
const bcrypt=createRequire(import.meta.url)("bcrypt");
const fixture=JSON.parse(readFileSync(new URL("./fixtures/bcrypt-5.1.1-hashes.json",import.meta.url),"utf8")).fixtures;
const legacy=fixture.find(x=>x.name==="account password at the application cost (12)");
const unavailable=e=>{assert.equal(e.statusCode,503);assert.equal(e.message,"Password checks are temporarily unavailable. Try again.");return true;};
const shape=/^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;
test("new hashes use fixed costs and fresh16-byte salts/32-byte outputs",async()=>{const a=await hashPassword("Owned-password1"),b=await hashPassword("Owned-password1");assert.notEqual(a,b);for(const value of[a,b]){const m=shape.exec(value);assert(m);assert.equal(Buffer.from(m[1],"base64").length,16);assert.equal(Buffer.from(m[2],"base64").length,32);assert.equal(await verifyPassword("Owned-password1",value),true);}});
test("full ASCII and multibyte suffixes beyond72 bytes remain distinct",async()=>{for(const prefix of["Aa1!"+"x".repeat(68),"Aa1!"+"界".repeat(22)+"xx"]){assert.equal(Buffer.byteLength(prefix),72);const hash=await hashPassword(prefix+"A");assert.equal(await verifyPassword(prefix+"A",hash),true);assert.equal(await verifyPassword(prefix+"B",hash),false);assert.equal(await verifyPassword(prefix,hash),false);}});
test("valid Unicode/NUL are exact and never normalized",async()=>{for(const password of["e\u0301","é","before\0after","\ufffd","🔐"]){const hash=await hashPassword(password);assert.equal(await verifyPassword(password,hash),true);assert.equal(await verifyPassword(password+"x",hash),false);}const hash=await hashPassword("é");assert.equal(await verifyPassword("e\u0301",hash),false);});
test("input bound includes every existing schema maximum and rejects illformed encoding",async()=>{for(const password of["Aa1!"+"界".repeat(124),"界".repeat(100),"x".repeat(512)]){const hash=await hashPassword(password);assert.equal(await verifyPassword(password,hash),true);}for(const password of["x".repeat(513),"界".repeat(171),"\ud800","\udc00","a\ud800z"]){await assert.rejects(hashPassword(password),e=>e.statusCode===400);assert.equal(await verifyPassword(password,legacy.hash),false);}});
test("legacy over72-byte inputs are refused but indistinguishable72-byte prefix remains legacy",async()=>{for(const row of fixture.filter(x=>x.passwordBytes>72)){assert.equal(await verifyPassword(row.password,row.hash),false);}const row=fixture.find(x=>x.name==="100 bytes (over the 72-byte bcrypt input limit)");assert.equal(await verifyPassword(row.password.slice(0,72),row.hash),true);});
test("stored PHC and legacy costs/lengths/canonical bits refuse before native admission",async()=>{const valid=await hashPassword("Owned-format1");const first=hashPassword("Owned-running1"),second=hashPassword("Owned-running2");try{const malformed=[valid+"\n",valid.replace("m=19456","m=194560000"),valid.replace("t=2","t=99"),valid.replace("p=1","p=2"),valid.replace("v=19","v=16"),valid.replace("argon2id","argon2i"),valid.replace("m=19456,t=2,p=1","t=2,m=19456,p=1"),valid.replace("$m=19456","$m=019456"),valid+"=","x".repeat(129),"",legacy.hash.replace("$12$","$31$"),legacy.hash.replace("$12$","$03$"),legacy.hash.replace("$2b$","$2y$"),legacy.hash+"\n"];
 const fields=valid.split("$");const salt=fields[4];fields[4]=salt.slice(0,-1)+"B";malformed.push(fields.join("$"));
 for(const hash of malformed)assert.equal(await verifyPassword("Owned-format1",hash),false,hash.slice(0,24));
 await assert.rejects(hashPassword("Third-worker1"),unavailable);
 }finally{await Promise.all([first,second]);}});
test("no waiting queue is shared across Argon2 and legacy jobs; subsequent work resumes",async()=>{const first=hashPassword("Owned-active1"),second=verifyPassword(legacy.password,legacy.hash);await assert.rejects(hashPassword("Owned-refused1"),unavailable);await assert.rejects(verifyPassword(legacy.password,legacy.hash),unavailable);await Promise.all([first,second]);const hash=await hashPassword("Owned-after1");assert.equal(await verifyPassword("Owned-after1",hash),true);});
test("an observer finishing early does not release an unfinished native permit",async()=>{const first=hashPassword("Owned-abandoned1"),second=hashPassword("Owned-abandoned2");assert.equal(await Promise.race([first,Promise.resolve("observer-finished")]),"observer-finished");await assert.rejects(hashPassword("Must-not-enter1"),unavailable);await Promise.all([first,second]);assert.match(await hashPassword("Later-permitted1"),shape);});

// Optional owned validation receipt: package provenance, not a general benchmark.
after(()=>{if(!process.env.R31_NATIVE_FACTS)return;const require=createRequire(import.meta.url);const files=Object.keys(require.cache).filter(name=>name.endsWith(".node")&&name.includes("/argon2/"));assert.equal(files.length,1,"actual loaded Argon2 native module");writeFileSync(process.env.R31_NATIVE_FACTS,JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,napi:process.versions.napi,loadedNative:files.map(path=>({path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")})),parameters:{algorithm:"argon2id",version:19,memoryKiB:19456,time:2,parallelism:1,saltBytes:16,hashBytes:32},maxRSSKiB:process.resourceUsage().maxRSS,qualification:"Actual controlled ordinary native tests; not production load or cross-platform acceptance"},null,2)+"\n",{mode:0o600});});

test('native work failure has one fixed safe operation diagnostic while saturation has none',async t=>{const entries=[];const spy=t.mock.method(logger,'error',(...args)=>entries.push(args));const marker='OWNED_NATIVE_FAILURE_PRIVATE_SENTINEL';const native=t.mock.method(bcrypt,'compare',async()=>{throw Error(marker+legacy.password+legacy.hash)});let failure;try{await verifyPassword(legacy.password,legacy.hash)}catch(e){failure=e}finally{native.mock.restore()}
 assert.equal(failure?.statusCode,503);assert.equal(failure?.message,'Password checks are temporarily unavailable. Try again.');assert(!JSON.stringify({statusCode:failure.statusCode,error:failure.error,message:failure.message}).includes(marker));
 const jobs=[hashPassword('Owned-safe-diagnostic-active1'),hashPassword('Owned-safe-diagnostic-active2')];try{await assert.rejects(hashPassword('Owned-safe-diagnostic-third1'),e=>e.statusCode===503)}finally{await Promise.all(jobs)}const after=await hashPassword('Owned-safe-diagnostic-recovered1');assert.equal(await verifyPassword('Owned-safe-diagnostic-recovered1',after),true);
 const facts={ordinaryFailure503:true,permitReleasedAfterFailure:true,saturation503:true,recoveredAfterSettlement:true,diagnosticCalls:entries.length,diagnostics:entries};if(process.env.R31_DIAG_FACTS)writeFileSync(process.env.R31_DIAG_FACTS,JSON.stringify(facts,null,2)+'\n',{mode:0o600});assert.equal(entries.length,1,'A genuine native work failure must leave one fixed diagnostic; capacity refusal must not log as native failure');const safe=JSON.stringify(entries);assert.match(safe,/bcrypt_verify/);for(const secret of [marker,legacy.password,legacy.hash])assert(!safe.includes(secret));spy.mock.restore();
});

// R31 enumeration cost (docs/remediation/r31-login-backoff.md): sign-in for an
// address without a usable stored hash does one admitted Argon2id check.
test("sign-in without a usable stored hash does one admitted Argon2id verification and is refused",async()=>{
 const hash=await hashPassword("Owned-login1");
 assert.equal(await verifyLoginPassword("Owned-login1",hash),true);
 assert.equal(await verifyLoginPassword("Owned-login2",hash),false);
 assert.equal(await verifyLoginPassword(legacy.password,legacy.hash),true);
 const long=fixture.find(x=>x.passwordBytes>72);
 const unusable=[[ "Owned-login1",null],["Owned-login1",undefined],["Owned-login1",""],["Owned-login1","x".repeat(129)],["Owned-login1",hash.replace("t=2","t=99")],[long.password,long.hash]];
 for(const [password,stored] of unusable)assert.equal(await verifyLoginPassword(password,stored),false);
 // The same admission as a real check: while two native jobs run, the
 // stand-in verification is refused exactly like a real one.
 const first=hashPassword("Owned-busy1"),second=hashPassword("Owned-busy2");
 try{
  for(const [password,stored] of [["Owned-login1",hash],...unusable])await assert.rejects(verifyLoginPassword(password,stored),unavailable);
  // Input no hash could accept is refused before native work for every address alike.
  for(const stored of [null,hash,legacy.hash])assert.equal(await verifyLoginPassword("x".repeat(513),stored),false);
 }finally{await Promise.all([first,second]);}
});
test("the stand-in verification costs about as much as a real Argon2id verification",async()=>{
 const hash=await hashPassword("Owned-cost1");
 const time=async(stored)=>{const start=process.hrtime.bigint();await verifyLoginPassword("Owned-cost2",stored);return Number(process.hrtime.bigint()-start)/1e6;};
 const real=[],standIn=[];
 await time(null);await time(hash);
 for(let i=0;i<9;i++){real.push(await time(hash));standIn.push(await time(null));}
 const median=v=>[...v].sort((a,b)=>a-b)[4];
 const ratio=median(standIn)/median(real);
 assert.ok(ratio>0.5&&ratio<2,`stand-in ${median(standIn)} ms, real ${median(real)} ms`);
});
