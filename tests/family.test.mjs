import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../server/worker.mjs';
import {generation,runJob} from '../server/generation.mjs';
import {getSecret} from '../server/family.mjs';

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_family.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_generation.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_accounts.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_media.sql',import.meta.url),'utf8'));
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
  assert.equal((await call('generation','POST',job))[1].mediaBytes,Buffer.byteLength('晚安，小兔。'));
  assert.equal(upstream.mock.callCount(),1);assert.equal((await call('generation/'+job.id))[1].text,'晚安，小兔。');
  assert.deepEqual({...db.prepare('SELECT reserved,media_bytes FROM families').get()},{reserved:0,media_bytes:Buffer.byteLength('晚安，小兔。')});
  await call('session/create','POST');assert.equal((await call('generation/'+job.id))[0],404);
});
test('private audio enforces publication, withdrawal and byte ranges',async()=>{
  const {call,env,db}=setup(),{family}=(await call('session/create','POST'))[1];
  const id='recording-12345',state={people:[{id:'kid',name:'听众',kind:'孩子'}],stories:[{id:'book',text:'正文',title:'故事',versions:[],recordings:[{id}],published:{rid:id,kids:['kid']}}],configs:[]};
  assert.equal((await call('library','PUT',{revision:0,state}))[0],200);
  db.prepare("INSERT INTO generation (family,id,fingerprint,kind,provider,model,style,input,status,reserve,bytes) VALUES(?,?,'fixture','voice','openai','','','','done',0,48)").run(family,id);
  const kid={family,kid:'kid'},request=(method,range)=>new Request('https://example.test/api/audio/'+id,{method,headers:range?{Range:range}:{}});
  const part=await generation(request('HEAD','bytes=12-19'),env,kid,id,true);
  assert.equal(part.status,206);assert.equal(part.headers.get('Content-Length'),'8');assert.equal(part.headers.get('Content-Range'),'bytes 12-19/48');
  assert.equal((await generation(request('HEAD','bytes=100-'),env,kid,id,true)).status,416);
  await assert.rejects(generation(request('HEAD'),env,{family:'another-family',kid:null},id,true),{status:404});
  state.stories[0].published=null;assert.equal((await call('library','PUT',{revision:1,state}))[0],200);
  await assert.rejects(generation(request('HEAD'),env,kid,id,true),{status:404});
});
test('one-time adult invitation, individual configuration permissions and durable budgets',async()=>{
  const {call,db}=setup();
  const owner=(await call('session/create','POST'))[1];
  const config={type:'write',provider:'openai',model:'writer',key:'test-only-credential',perDay:1,share:false};
  assert.equal((await call('configs/config-one','PUT',config))[0],200);
  const invitation=(await call('accounts','POST',{name:'照护者'}))[1];
  const member=(await call('session/login','POST',{pass:invitation.code}))[1];
  assert.ok(member.pass);assert.notEqual(member.adult,'owner');
  assert.equal((await call('session/login','POST',{pass:invitation.code}))[0],401);
  assert.deepEqual((await call('configs'))[1],[]);
  const job={id:'acl-job-00000001',kind:'write',provider:'openai',model:'writer',input:'一只猫',config:'config-one'};
  assert.equal((await call('generation','POST',job))[0],403);
  assert.equal((await call('credentials/openai','PUT',{key:'test-fixture-only'}))[0],403);
  assert.equal((await call('accounts','POST',{name:'越权'}))[0],403);
  await call('session/login','POST',{pass:owner.pass});
  await call('configs/config-one','PUT',{...config,share:true});
  await call('session/login','POST',{pass:member.pass});
  assert.equal((await call('generation','POST',job))[0],202);
  assert.equal((await call('generation','POST',job))[0],202);
  assert.equal((await call('generation','POST',{...job,id:'acl-job-00000002'}))[0],429);
  assert.equal(db.prepare('SELECT count(*) AS n FROM service_usage').get().n,1);
  await call('session/login','POST',{pass:owner.pass});
  await call('accounts/'+member.adult,'DELETE');
  assert.equal((await call('session/login','POST',{pass:member.pass}))[0],401);
});
test('custom gateway configuration checks public DNS and requires a fresh key for changes',async t=>{
  const {call,env}=setup();env.PUBLIC_PROVIDER_GATEWAYS='1';
  await call('session/create','POST');
  let address='93.184.216.34';
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(new URL(url).hostname,'cloudflare-dns.com');
    assert.equal(options.headers.Authorization,undefined);
    return Response.json({Status:0,Answer:new URL(url).searchParams.get('type')==='A'?[{type:1,data:address}]:[]});
  });
  const c={provider:'openai',type:'write',model:'fixture',endpoint:'https://gateway.example/v1',key:'test-only-credential'};
  assert.equal((await call('configs/gateway','PUT',c))[0],200);
  assert.equal((await call('configs/gateway','PUT',{...c,endpoint:'https://other.example/v1',key:''}))[0],400);
  address='192.168.1.1';
  assert.equal((await call('configs/gateway','PUT',c))[0],400);
});
