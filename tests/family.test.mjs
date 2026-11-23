import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../server/worker.mjs';
import {getSecret} from '../server/family.mjs';

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_family.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){
    const stmt=db.prepare(sql);
    const bind=(...args)=>({bind,first:()=>stmt.get(...args),run:()=>({meta:stmt.run(...args)}),all:()=>({results:stmt.all(...args)})});
    return bind();
  },batch(stmts){db.exec('BEGIN');try{const r=stmts.map(s=>s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const files=new Map(),env={DB,VAULT_KEY:'ab'.repeat(32),FILES:{put:(k,v)=>files.set(k,v),get:k=>files.has(k)?{json:()=>JSON.parse(files.get(k))}:null,delete:k=>files.delete(k)}};
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
