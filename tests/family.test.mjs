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
  const files=new Map(),env={DB,TURNSTILE_SITE_KEY:'fixture-public',TURNSTILE_SECRET_KEY:'fixture-private',RESEND_API_KEY:'fixture',RESEND_FROM:'post@example.test',JOBS:{send:async()=>{}},VAULT_KEY:'ab'.repeat(32),FILES:{put:(k,v)=>files.set(k,v),get:k=>files.has(k)?{json:()=>JSON.parse(files.get(k))}:null,delete:k=>files.delete(k)}};
  let token='';
  async function call(path,method='GET',body,origin='https://example.test'){
    const res=await worker.fetch(new Request('https://example.test/api/'+path,{method,headers:{origin,cookie:token,'content-type':'application/json'},body:body&&JSON.stringify(body)}),env);
    if(res.headers.has('set-cookie'))token=res.headers.get('set-cookie').split(';')[0];
    return [res.status,await res.json()];
  }
  async function sendWithProof(email){
    const original=globalThis.fetch;
    const proof=crypto.randomUUID();
    globalThis.fetch=(url,options)=>{
      if(url!=='https://challenges.cloudflare.com/turnstile/v0/siteverify')return original(url,options);
      assert.deepEqual(JSON.parse(options.body),{secret:'fixture-private',response:proof});
      return Promise.resolve(Response.json({success:true,action:'email_send',hostname:'example.test'}));
    };
    try{return await call('session/email/send','POST',{email,turnstileToken:proof})}
    finally{globalThis.fetch=original;}
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
      const [status,{id}]=await sendWithProof(email);
      assert.equal(status,200);return {id,code};
    }finally{globalThis.fetch=original;}
  }
  async function login(email='owner@example.test',claim){
    db.prepare("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'cooldown:%'").run();
    const challenge=await receive(email);
    return call('session/email/verify','POST',{...challenge,claim});
  }
  return {call,env,db,receive,login,sendWithProof};
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
  const upstream=t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'月亮摇篮',text:'晚安，小兔。'})}}]}));
  await Promise.all([runJob(env,{family,id:job.id}),runJob(env,{family,id:job.id})]);
  assert.equal((await call('generation','POST',job))[1].mediaBytes,Buffer.byteLength('月亮摇篮晚安，小兔。'));
  assert.equal(upstream.mock.callCount(),1);assert.equal((await call('generation/'+job.id))[1].text,'晚安，小兔。');
  assert.deepEqual({...db.prepare('SELECT reserved,media_bytes FROM families').get()},{reserved:0,media_bytes:Buffer.byteLength('月亮摇篮晚安，小兔。')});
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
test('a parent can reuse a saved writing key for narration at the same provider and endpoint',async t=>{
  const {call,login,env}=setup();
  await login();
  const endpoint='https://gateway.example/v1';
  env.PROVIDER_ORIGINS='https://gateway.example';
  const writer={provider:'openai',endpoint,type:'write',model:'writer',key:'saved-fixture-key',share:true};
  assert.equal((await call('configs/writer','PUT',writer))[0],200);
  const voice={provider:'openai',endpoint:endpoint+'/',type:'voice',model:'',keyFrom:'writer'};
  assert.equal((await call('configs/voice','PUT',{...voice,provider:'deepseek'}))[0],400);
  assert.equal((await call('configs/voice','PUT',{...voice,endpoint:endpoint+'/other'}))[0],400);
  assert.equal((await call('configs/voice','PUT',voice))[0],200);
  const list=(await call('configs'))[1];
  assert.ok(list.every(c=>!('encrypted' in c)&&!('key' in c)));
  assert.equal(list.find(c=>c.id==='voice').share,0);

  const invitation=(await call('accounts','POST',{name:'照护者'}))[1];
  await login('member@example.test',invitation.code);
  assert.equal((await call('configs/member-voice','PUT',voice))[0],400);
  await call('session/logout','POST');await login('other@example.test');
  assert.equal((await call('configs/other-voice','PUT',voice))[0],400);

  await call('session/logout','POST');await login();
  assert.equal((await call('configs/writer','DELETE'))[0],200);
  t.mock.method(globalThis,'fetch',async(url,{headers})=>{
    assert.equal(url,endpoint+'/models');
    assert.equal(headers.Authorization,'Bearer '+writer.key);
    return Response.json({data:[]});
  });
  assert.equal((await call('configs/voice/check','POST',{}))[0],200);
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
  const {db,call,receive,sendWithProof}=setup();
  const verify=challenge=>call('session/email/verify','POST',challenge);
  const email='parent@example.test';
  const challenge=await receive(email);
  assert.equal((await sendWithProof(email))[0],429);
  const wrong=challenge.code==='000000'?'000001':'000000';
  for(let i=0;i<5;i++)assert.equal((await verify({...challenge,code:wrong}))[0],401);
  assert.equal((await verify(challenge))[0],401);
  db.prepare("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'cooldown:%'").run();
  const expired=await receive(email);
  db.prepare('UPDATE email_challenges SET sent=sent-601').run();
  assert.equal((await verify(expired))[0],401);
  assert.equal(db.prepare('SELECT count(*) n FROM families').get().n,0);
  db.prepare("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'cooldown:%'").run();
  const valid=await receive(email);
  const results=await Promise.all([verify(valid),verify(valid)]);
  assert.deepEqual(results.map(r=>r[0]).sort(),[200,401]);
  assert.equal((await sendWithProof(email))[0],429);
  assert.equal(db.prepare('SELECT count(*) n FROM families').get().n,1);
});

test('retiring legacy shelves rejects old credentials and preserves verified households',async()=>{
  const {db,login}=setup();
  const {hash,newToken}=await import('../server/common.mjs');
  const pass='story-'+newToken();
  db.prepare('INSERT INTO families(id,pass_hash) VALUES(?,?)').run('legacy',await hash(pass));
  assert.equal((await login('parent@example.test',pass))[0],400);
  const [,current]=await login('parent@example.test');
  db.exec(readFileSync(new URL('../migrations/0007_retire_legacy.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT id FROM families').get().id,current.family);
  assert.equal(db.prepare('SELECT family FROM erased_families').get().family,'legacy');
  assert.equal((await login('parent@example.test'))[1].family,current.family);
});

test('a transport error or sending budget cannot invalidate an already delivered code',async t=>{
  const {db,env,call,receive,sendWithProof}=setup();
  const email='original@example.test',first=await receive(email);
  const allowResend=()=>db.prepare("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'cooldown:%'").run();
  allowResend();
  const mail=t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:503}));
  assert.equal((await sendWithProof(email))[0],503);
  allowResend();env.EMAIL_DAILY_LIMIT='1';
  assert.equal((await sendWithProof(email))[0],429);
  assert.equal(mail.mock.callCount(),1);
  assert.equal((await call('session/email/verify','POST',first))[0],200);
});

test('mail requires a single-use Turnstile proof for this origin and action before consuming mail quota',async t=>{
  const {call,db}=setup();
  const email='fixture@example.test';
  const send=token=>call('session/email/send','POST',{email,turnstileToken:token});
  assert.equal((await send(''))[0],400);
  let result;
  const site=t.mock.method(globalThis,'fetch',async url=>{
    if(url==='https://api.resend.com/emails')return Response.json({id:'fixture'});
    return Response.json(result);
  });
  for(const fields of [{success:false},{hostname:'other.test'},{action:'checkout'}]){
    result={success:true,hostname:'example.test',action:'email_send',...fields};
    assert.equal((await send('proof'))[0],403);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM email_send_limits WHERE bucket='outbox' OR bucket LIKE 'mail:%'").get().n,0);
  result={success:true,hostname:'example.test',action:'email_send'};
  assert.equal((await send('proof'))[0],200);
  assert.equal((await send('proof'))[0],429);
  assert.equal(site.mock.calls.filter(c=>c.arguments[0]==='https://api.resend.com/emails').length,1);
});

test('verification limits guesses across challenges and recovers after the window',async()=>{
  const {call,db}=setup();
  const guess=()=>call('session/email/verify','POST',{id:'a'.repeat(64),code:'000000'});
  for(let i=0;i<12;i++)assert.equal((await guess())[0],401);
  assert.equal((await guess())[0],429);
  db.prepare("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'verify-minute:%'").run();
  assert.equal((await guess())[0],401);
  db.prepare("UPDATE email_send_limits SET used=60 WHERE bucket LIKE 'verify-hour:%'").run();
  assert.equal((await guess())[0],429);
});

test('mailbox daily allowance survives hourly reset and IP allowance spans addresses',async()=>{
  const {receive,sendWithProof,db}=setup();
  const email='quota@example.test';
  await receive(email);
  db.exec("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'cooldown:%' OR bucket LIKE 'mail:%'");
  db.exec("UPDATE email_send_limits SET used=12 WHERE bucket LIKE 'mail-day:%'");
  assert.equal((await sendWithProof(email))[0],429);
  db.exec("UPDATE email_send_limits SET used=20 WHERE bucket LIKE 'ip:%'");
  assert.equal((await sendWithProof('another@example.test'))[0],429);
  assert.equal(db.prepare("SELECT used FROM email_send_limits WHERE bucket='outbox'").get().used,1);
});

test('a two-hour story keeps its model title and resumes at the first unfinished chapter', async t => {
  const {call,env,db,login}=setup();
  const {family}=(await login())[1];
  await call('credentials/openai','PUT',{key:'fixture-value'});
  const input='消防车嘟嘟的故事，需要写成播放时长2小时左右的故事，有不同的场景，对于涉及到的一些内容应该有英文单词说明，目标年龄是3岁男孩';
  const job={id:'two-hour-fire-engine',kind:'write',provider:'openai',model:'fixture',input};
  const task={family,id:job.id};
  const chapters=Array.from({length:24},(_,i)=>({title:'嘟嘟的第'+(i+1)+'站',scene:'去第'+(i+1)+'站帮助朋友'}));
  const calls=[];
  let interrupt=true;
  t.mock.method(globalThis,'fetch',async(_url,request)=>{
    const {messages}=JSON.parse(request.body);
    assert.ok(messages.some(m=>m.content===input));
    let content;
    if(messages[0].content.includes('先规划全书')){
      calls.push('大纲');
      assert.match(messages[0].content,/24 章/);
      content=JSON.stringify({title:'嘟嘟的小城巡游',chapters});
    }else{
      const context=messages.at(-1).content;
      const index=Number(/现在写第 (\d+) 章/.exec(context)[1]);
      calls.push(index);
      assert.match(messages[0].content,/900 个朗读字/);
      if(index>1)assert.ok(context.includes('上一站是'+(index-1)+'。'));
      if(index===3 && interrupt)return new Response(null,{status:429});
      content='嘟嘟的车轮轻轻转动。'.repeat(110)+'这是车轮，wheel。上一站是'+index+'。';
    }
    return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
  });
  assert.equal((await call('generation','POST',job))[0],202);
  const step=()=>runJob(env,task);
  for(let i=0;i<4;i++)await step();
  const read=async()=>(await call('generation/'+job.id))[1];
  const failed=await read();
  assert.equal(failed.status,'failed');
  assert.equal(failed.completed,2);
  assert.equal(failed.retryable,true);
  assert.equal(failed.text,undefined);
  interrupt=false;
  const retry={attempt:'retry-fire-engine'};
  assert.equal((await call('generation/'+job.id+'/retry','POST',retry))[0],200);
  assert.equal((await call('generation/'+job.id+'/retry','POST',retry))[0],200);
  for(let i=2;i<24;i++)await Promise.all([step(),step()]);
  await step();
  const done=await read();
  assert.equal(done.status,'done',done.error);
  assert.equal(done.title,'嘟嘟的小城巡游');
  assert.equal(done.completed,24);
  assert.equal([...done.text.matchAll(/^第(\d+)章 /gm)].length,24);
  assert.ok(done.text.endsWith('上一站是24。'));
  assert.ok(done.text.length>=120*180*0.85);
  assert.deepEqual(calls,['大纲',1,2,3,...Array.from({length:22},(_,i)=>i+3)]);
  const familyBytes=db.prepare('SELECT reserved,media_bytes FROM families').get();
  assert.equal(familyBytes.reserved,0);
  assert.equal(familyBytes.media_bytes,Buffer.byteLength(done.title+done.text));
});

test('chapter calls honor managed writing limits and an explicit retry pays for one call',async t=>{
  const {call,env,db,login}=setup();
  const {family}=(await login())[1];
  const config={type:'write',provider:'openai',model:'fixture',key:'mock-key-only',perDay:1};
  assert.equal((await call('configs/writer','PUT',config))[0],200);
  const job={id:'chapter-quota-request',kind:'write',config:'writer',provider:'openai',model:'fixture',input:'故事时长10分钟'};
  const mock=t.mock.method(globalThis,'fetch',async(_url,req)=>{
    const plan=JSON.parse(req.body).messages[0].content.includes('先规划全书');
    const content=plan?JSON.stringify({title:'河畔的朋友',chapters:[{title:'听见水声',scene:'到达小河'},{title:'找到小鸭',scene:'小鸭回家'}]}):'小鸭慢慢地游回家。'.repeat(120);
    return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
  });
  assert.equal((await call('generation','POST',job))[0],202);
  const next=()=>runJob(env,{family,id:job.id});
  await next();await next();
  const failed=(await call('generation/'+job.id))[1];
  assert.equal(failed.status,'failed');assert.match(failed.error,/用量限制/);
  assert.equal(mock.mock.callCount(),1);
  const path='generation/'+job.id+'/retry',attempt={attempt:'quota-retry-request'};
  assert.equal((await call(path,'POST',attempt))[0],429);
  await call('configs/writer','PUT',{...config,perDay:3});
  assert.equal((await call(path,'POST',attempt))[0],200);
  await next();await next();
  const [status,done]=await call(path,'POST',attempt);
  assert.equal(status,200);assert.equal(done.status,'done',done.error);
  assert.equal(mock.mock.callCount(),3);
  assert.equal(db.prepare('SELECT sum(units) AS units FROM service_usage').get().units,3*job.input.length);
});
