import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../server/worker.mjs';
import {runJob} from '../server/generation.mjs';
import {getSecret} from '../server/family.mjs';

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_family.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_generation.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){
    const stmt=db.prepare(sql);
    const bind=(...args)=>({bind,first:()=>stmt.get(...args),run:()=>({meta:stmt.run(...args)}),all:()=>({results:stmt.all(...args)})});
    return bind();
  },batch(stmts){db.exec('BEGIN');try{const r=stmts.map(s=>s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const files=new Map(),env={DB,JOBS:{send:async()=>{}},VAULT_KEY:'ab'.repeat(32),FILES:{put:(k,v)=>files.set(k,v),get:k=>files.has(k)?{json:()=>JSON.parse(files.get(k))}:null,delete:k=>files.delete(k)}};
  let token='';
  async function call(path,method='GET',body,origin='https://example.test'){
    const res=await worker.fetch(new Request('https://example.test/api/'+path,{method,headers:{origin,cookie:token,'content-type':'application/json'},body:body&&JSON.stringify(body)}),env);
    if(res.headers.has('set-cookie'))token=res.headers.get('set-cookie').split(';')[0];
    return [res.status,await res.json()];
  }
  return {call,env,db};
}
test('household sessions, encrypted credentials, quotas and child access',async()=>{
  const {call,env,db}=setup();
  assert.equal((await call('library'))[0],401);
  assert.equal((await call('session/create','POST',{},'https://other.test'))[0],403);
  const [status,{family,pass}]=await call('session/create','POST');assert.equal(status,200);
  const secret='fixture-for-tests';
  assert.equal((await call('credentials/openai','PUT',{key:secret}))[0],200);
  assert.equal(await getSecret(env,family,'openai'),secret);
  assert.ok(!db.prepare('select encrypted from credentials').get().encrypted.includes(secret));
  const state={people:[{id:'a',name:'家长',kind:'成人'},{id:'b',name:'听众',kind:'孩子'}],stories:[],configs:[],prefs:{}};
  assert.equal((await call('library','PUT',{state,revision:0}))[0],200);
  assert.equal((await call('library','PUT',{state,revision:0}))[0],409);
  assert.equal((await call('library','PUT',{state:{...state,stories:Array(101).fill({})},revision:1}))[0],400);
  assert.equal((await call('session/child','POST',{kid:'b'}))[0],200);
  assert.equal((await call('credentials/openai'))[0],403);
  assert.equal((await call('library','PUT',{state,revision:1}))[0],403);
  assert.deepEqual((await call('library'))[1].state.people.map(p=>p.id),['b']);
  assert.equal((await call('library','PATCH',{id:'fox',favorite:true,progress:3}))[0],200);
  assert.equal((await call('session/login','POST',{pass}))[0],200);
  await call('session/create','POST');
  assert.equal((await call('credentials/openai'))[1].configured,false);
  assert.equal((await call('library'))[1].state,null);
});
test('queue redelivery only buys one story and reservation settles once',async t=>{
  const {call,env,db}=setup(),{family}=(await call('session/create','POST'))[1];
  const job={id:'request-test-0001',kind:'write',provider:'deepseek',model:'deepseek-flash',input:'月亮和小兔'};
  assert.equal((await call('generation','POST',job))[0],422);
  await call('credentials/deepseek','PUT',{key:'fixture-value'});
  assert.equal((await call('generation','POST',job))[0],202);
  assert.equal((await call('generation','POST',job))[0],202);
  assert.equal((await call('generation','POST',{...job,input:'另一个故事'}))[0],409);
  assert.equal(db.prepare('SELECT reserved FROM families').get().reserved,64000);
  const upstream=t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'晚安，小兔。'}}]}));
  await Promise.all([runJob(env,{family,id:job.id}),runJob(env,{family,id:job.id})]);
  assert.equal(upstream.mock.callCount(),1);assert.equal((await call('generation/'+job.id))[1].text,'晚安，小兔。');
  assert.deepEqual({...db.prepare('SELECT reserved,media_bytes FROM families').get()},{reserved:0,media_bytes:Buffer.byteLength('晚安，小兔。')});
  await call('session/create','POST');assert.equal((await call('generation/'+job.id))[0],404);
});
