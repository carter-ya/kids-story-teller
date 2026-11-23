// Exercise the actual workerd Fetch, WebSocket, D1, queue and R2 implementations.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const upstream=`export default {async fetch(req) {
  const url=new URL(req.url);
  if(!['api.openai.com','api.deepseek.com'].includes(url.hostname)||req.headers.get('Authorization')!=='Bearer test-fixture-only')return new Response(null,{status:401});
  if(url.pathname.includes('chat/completions'))return Response.json({choices:[{finish_reason:'stop',message:{content:'小兔回到家。'}}]});
  const [client,server]=Object.values(new WebSocketPair());server.accept();
  server.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.type==='session.update')server.send(JSON.stringify({type:'session.updated'}));
    if(m.type==='response.create'){server.send(JSON.stringify({type:'response.output_audio.delta',delta:'AAAAAAAAAAA='}));server.send(JSON.stringify({type:'response.done',response:{status:'completed'}}));}
    if(m.event==='finish_text'){server.send(new Uint8Array(8));server.send(JSON.stringify({event:'finish',code:'success'}));}
  });
  return new Response(null,{status:101,webSocket:client});
}}`;

const mf=new Miniflare(convertV4MiniflareOptions({workers:[
  { name:'app',modules:['worker','common','family','generation','providers'].map(name=>({type:'ESModule',path:'server/'+name+'.mjs'})),compatibilityDate:'2026-08-01',
    outboundService:'provider-fixture',d1Databases:['DB'],r2Buckets:['FILES'],
    queueProducers:{JOBS:'audio'},queueConsumers:{audio:{maxBatchSize:1,maxBatchTimeout:0}},
    bindings:{VAULT_KEY:randomBytes(32).toString('hex')} },
  { name:'provider-fixture',modules:true,script:upstream,compatibilityDate:'2026-08-01' }
]}));
try{
  const db=await mf.getD1Database('DB','app');
  for(const fn of ['0001_family.sql','0002_generation.sql']){
    let sql='';
    for(const line of readFileSync('migrations/'+fn,'utf8').trim().split('\n')){
      sql+=line+'\n';
      if(line.trim().endsWith(';')&&(!sql.trim().startsWith('CREATE TRIGGER')||line.trim()==='END;')){await db.prepare(sql.trim()).run();sql='';}
    }
  }
  let cookie='';
  async function api(p,method='GET',data,headers={}){
    const r=await mf.dispatchFetch('https://family.example/api/'+p,{method,headers:{Origin:'https://family.example',Cookie:cookie,'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined});
    if(r.headers.has('Set-Cookie'))cookie=r.headers.get('Set-Cookie').split(';')[0];return r;
  }
  assert.equal((await api('session/create','POST',{})).status,200);
  assert.equal((await api('credentials/openai','PUT',{key:'test-fixture-only'})).status,200);
  const write={id:'workerd-write-test',kind:'write',provider:'openai',model:'fixture',input:'小兔'};
  await api('generation','POST',write);
  async function waitForJob(id){
    for(let i=0;i<80;i++){
      const job=await (await api('generation/'+id)).json();
      if(job.status==='done'||job.status==='failed')return job;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.fail('Generation timed out');
  }
  assert.equal((await waitForJob(write.id)).text,'小兔回到家。');
  const takes=[];
  for(const provider of ['deepseek','openai']){
    assert.equal((await api('credentials/'+provider,'PUT',{key:'test-fixture-only'})).status,200);
    const id='workerd-fixture-'+provider;
    let r=await api('generation','POST',{id,kind:'voice',provider,style:'温柔晚安',input:'晚安。'});
    assert.equal(r.status,202);const result=await waitForJob(id);
    assert.equal(result.status,'done',JSON.stringify(result));
    assert.equal(result.bytes,52);
    const head=await api('audio/'+id,'HEAD');assert.equal(head.headers.get('Content-Length'),'52');
    const raw=await api('audio/'+id,'GET',null,{Range:'bytes=0-3'});assert.equal(raw.status,206);assert.equal(await raw.text(),'RIFF');
    takes.push({id,title:'作品',text:'晚安。',duration:result.duration});
  }
  const state={people:[{id:'kid',name:'小兔',kind:'孩子'}],stories:[{id:'story',text:'正文',title:'故事',versions:[],recordings:takes,published:{rid:takes[0].id,kids:['kid']}}],configs:[]};
  assert.equal((await api('library','PUT',{revision:0,state})).status,200);
  assert.equal((await api('session/child','POST',{kid:'kid'})).status,200);
  assert.equal((await api('audio/'+takes[0].id)).status,200);
  assert.equal((await api('audio/'+takes[1].id)).status,404);
  console.log('PASS isolated workerd gateways → real local queue / D1 / R2 → authenticated WAV ranges and child publication for both providers');
}finally{await mf.dispose();}
