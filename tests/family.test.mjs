import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../server/worker.mjs';
import {generation,runJob} from '../server/generation.mjs';
import {getSecret} from '../server/family.mjs';

function setup(){
  const db=new DatabaseSync(':memory:');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync(new URL(name,dir),'utf8'));
  const DB={prepare(sql){
    const stmt=db.prepare(sql);
    const bind=(...args)=>({bind,first:()=>stmt.get(...args),run:()=>({meta:stmt.run(...args)}),all:()=>({results:stmt.all(...args)})});
    return bind();
  },batch(stmts){db.exec('BEGIN');try{const r=stmts.map(s=>{const results=s.all().results;return {results,meta:db.prepare('SELECT changes() AS changes').get()}});db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const files=new Map(),env={DB,RESEND_API_KEY:'fixture',RESEND_FROM:'post@example.test',JOBS:{send:async()=>{}},VAULT_KEY:'ab'.repeat(32),FILES:{put:(k,v)=>files.set(k,v),get:k=>files.has(k)?{json:()=>JSON.parse(files.get(k))}:null,delete:k=>files.delete(k)}};
  let token='';
  async function call(path,method='GET',body,origin='https://example.test'){
    const res=await worker.fetch(new Request('https://example.test/api/'+path,{method,headers:{origin,cookie:token,'content-type':'application/json'},body:body&&JSON.stringify(body)}),env);
    if(res.headers.has('set-cookie'))token=res.headers.get('set-cookie').split(';')[0];
    return [res.status,await res.json()];
  }
  async function receive(email){
    let code;
    const original=globalThis.fetch;
    try{
      globalThis.fetch=async(url,options)=>{
        assert.equal(url,'https://api.resend.com/emails');
        const mail=JSON.parse(options.body);
        assert.deepEqual(mail.to,[email.toLowerCase()]);
        code=mail.text.match(/\d{6}/)[0];
        return Response.json({id:'fixture'});
      };
      const [status,{id}]=await call('session/email/send','POST',{email});
      assert.equal(status,200);return {id,code};
    }finally{globalThis.fetch=original;}
  }
  async function login(email='owner@example.test',claim){
    db.prepare('UPDATE email_challenges SET sent=sent-61 WHERE email=?').run(email);
    const challenge=await receive(email);
    return call('session/email/verify','POST',{...challenge,claim});
  }
  return {call,env,db,receive,login};
}
test('household sessions, encrypted credentials, quotas and child access',async()=>{
  const {call,env,db,login}=setup();
  assert.equal((await call('library'))[0],401);
  assert.equal((await call('session/email/send','POST',{},'https://other.test'))[0],403);
  const [status,{family}]=await login();assert.equal(status,200);
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
  assert.equal((await login())[0],200);
  await call('session/logout','POST');await login('other@example.test');
  assert.equal((await call('credentials/openai'))[1].configured,false);
  assert.equal((await call('library'))[1].state,null);
});
test('queue redelivery only buys one story and reservation settles once',async t=>{
  const {call,env,db,login}=setup(),{family}=(await login())[1];
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
  await call('session/logout','POST');await login('other@example.test');assert.equal((await call('generation/'+job.id))[0],404);
});
test('private audio enforces publication, withdrawal and byte ranges',async()=>{
  const {call,env,db,login}=setup(),{family}=(await login())[1];
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
  const {call,db,login}=setup();
  const owner=(await login())[1];
  const config={type:'write',provider:'openai',model:'writer',key:'test-only-credential',perDay:1,share:false};
  assert.equal((await call('configs/config-one','PUT',config))[0],200);
  const invitation=(await call('accounts','POST',{name:'照护者'}))[1];
  await call('session/logout','POST');
  const member=(await login('member@example.test',invitation.code))[1];
  assert.equal(member.family,owner.family);assert.notEqual(member.adult,'owner');
  assert.equal((await login('member@example.test',invitation.code))[0],409);
  assert.deepEqual((await call('configs'))[1],[]);
  const job={id:'acl-job-00000001',kind:'write',provider:'openai',model:'writer',input:'一只猫',config:'config-one'};
  assert.equal((await call('generation','POST',job))[0],403);
  assert.equal((await call('credentials/openai','PUT',{key:'test-fixture-only'}))[0],403);
  assert.equal((await call('accounts','POST',{name:'越权'}))[0],403);
  await login();
  await call('configs/config-one','PUT',{...config,share:true});
  await login('member@example.test');
  assert.equal((await call('generation','POST',job))[0],202);
  assert.equal((await call('generation','POST',job))[0],202);
  assert.equal((await call('generation','POST',{...job,id:'acl-job-00000002'}))[0],429);
  assert.equal(db.prepare('SELECT count(*) AS n FROM service_usage').get().n,1);
  await login();
  await call('accounts/'+member.adult,'DELETE');
  assert.equal((await login('member@example.test'))[0],403);
});
test('custom gateway configuration checks public DNS and requires a fresh key for changes',async t=>{
  const {call,env,login}=setup();env.PUBLIC_PROVIDER_GATEWAYS='1';
  await login();
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

test('verified mailbox is required, challenges expire and each code works once',async()=>{
  const {db,call,receive}=setup();
  const verify=challenge=>call('session/email/verify','POST',challenge);
  const email='parent@example.test';
  const challenge=await receive(email);
  assert.equal((await call('session/email/send','POST',{email}))[0],429);
  const wrong=challenge.code==='000000'?'000001':'000000';
  for(let i=0;i<5;i++)assert.equal((await verify({...challenge,code:wrong}))[0],401);
  assert.equal((await verify(challenge))[0],401);
  db.prepare('UPDATE email_challenges SET sent=sent-61').run();
  const expired=await receive(email);
  db.prepare('UPDATE email_challenges SET sent=sent-601').run();
  assert.equal((await verify(expired))[0],401);
  assert.equal(db.prepare('SELECT count(*) n FROM families').get().n,0);
  const valid=await receive(email);
  const results=await Promise.all([verify(valid),verify(valid)]);
  assert.deepEqual(results.map(r=>r[0]).sort(),[200,401]);
  assert.equal((await call('session/email/send','POST',{email}))[0],429);
  assert.equal(db.prepare('SELECT count(*) n FROM families').get().n,1);
});

test('migrating a legacy account preserves its family and retires the old proof',async()=>{
  const {db,login,call}=setup();
  const {hash,newToken}=await import('../server/common.mjs');
  const pass='story-'+newToken();
  db.prepare('INSERT INTO families(id,pass_hash) VALUES(?,?)').run('original',await hash(pass));
  const [status,account]=await login('parent@example.test',pass);
  assert.equal(status,200);assert.equal(account.family,'original');
  assert.equal((await call('session/login','POST',{pass}))[0],404);
  assert.equal((await login('other@example.test',pass))[0],409);
  assert.equal((await login('parent@example.test'))[1].family,'original');
  assert.equal(db.prepare('SELECT count(*) AS n FROM families').get().n,1);
});
