// Private, in-process inbox for the local browser test. No HTTP mailbox or delivery bypass.
import {randomBytes} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

export async function emailBrowserFixture(){
  const inbox=new Map();
  let advanceDraft,finishDraft;
  const nextParagraph=new Promise(resolve=>{advanceDraft=resolve;});
  const chapterEnd=new Promise(resolve=>{finishDraft=resolve;});
  const app={
    name:'app',modules:readdirSync('server').filter(f=>f.endsWith('.mjs')).sort((a,b)=>Number(b==='worker.mjs')-Number(a==='worker.mjs'))
      .map(f=>({type:'ESModule',path:'server/'+f})),compatibilityDate:'2026-08-01',
    d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{JOBS:'jobs'},queueConsumers:{jobs:{maxBatchSize:1,maxBatchTimeout:0}},
    serviceBindings:{ASSETS:async request=>{
      const name=new URL(request.url).pathname;
      const file=resolve('web','.'+(name==='/'?'/index.html':name));
      if(!file.startsWith(resolve('web')+sep))return new Response(null,{status:404});
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.m4a':'audio/mp4','.webp':'image/webp'};
      try{return new Response(readFileSync(file),{headers:{'Content-Type':types[extname(file)]||'application/octet-stream'}});}
      catch{return new Response(null,{status:404});}
    }},
    bindings:{VAULT_KEY:randomBytes(32).toString('hex'),TURNSTILE_SITE_KEY:'fixture-public',TURNSTILE_SECRET_KEY:'fixture-private',RESEND_API_KEY:'fixture',RESEND_FROM:'post@example.test'},
    outboundService:async request=>{
      if(request.url==='https://challenges.cloudflare.com/turnstile/v0/siteverify'){
        const {secret,response}=await request.json();
        return Response.json({success:secret==='fixture-private' && response.startsWith('fixture-'),action:'email_send',hostname:'127.0.0.1'});
      }
      if(request.url==='https://api.openai.com/v1/chat/completions'){
        const {messages,stream}=await request.json();
        if(stream && messages.at(-1).content.includes('现在写第 3 章')){
          const encoder=new TextEncoder();
          const body=new ReadableStream({async start(controller){
            const send=(text,finish=null)=>controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:finish}]})+'\n\n'));
            send('嘟嘟打开车灯。');
            await nextParagraph;
            send('小兔跳上车。');
            await chapterEnd;
            send('嘟嘟轻轻转动车轮。'.repeat(125),'stop');
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();
          }});
          return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
        }
        const planning=messages[0].content.includes('先规划全书');
        const content=planning ? JSON.stringify({title:'嘟嘟的小城巡游',chapters:Array.from({length:24},(_,i)=>({title:'第'+(i+1)+'站',scene:'巡游小城'}))}) : '嘟嘟轻轻转动车轮。'.repeat(125);
        return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
      }
      if(request.url!=='https://api.resend.com/emails')return new Response(null,{status:404});
      const mail=await request.json();inbox.set(mail.to[0],mail.text.match(/\d{6}/)[0]);
      return Response.json({id:crypto.randomUUID()});
    }
  };
  const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,workers:[app]}));
  try{
    const db=await mf.getD1Database('DB','app');
    for(const file of readdirSync('migrations').sort()){
      let statement='';
      for(const line of readFileSync('migrations/'+file,'utf8').trim().split('\n')){
        statement+=line+'\n';
        if(line.trim().endsWith(';')&&(!statement.trim().startsWith('CREATE TRIGGER')||line.trim()==='END;')){
          await db.prepare(statement).run();statement='';
        }
      }
    }
    return {url:(await mf.ready).href,advanceDraft,finishDraft,code:email=>inbox.get(email),
      advanceCooldown:()=>db.prepare("UPDATE email_send_limits SET expires=0 WHERE bucket LIKE 'cooldown:%'").run(),
      close:()=>{advanceDraft();finishDraft();return mf.dispose();}};
  }catch(error){await mf.dispose();throw error;}
}
