// Private, in-process inbox for the local browser test. No HTTP mailbox or delivery bypass.
import {randomBytes} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

export async function emailBrowserFixture(){
  const inbox=new Map();
  const app={
    name:'app',modules:readdirSync('server').filter(f=>f.endsWith('.mjs')).sort((a,b)=>Number(b==='worker.mjs')-Number(a==='worker.mjs'))
      .map(f=>({type:'ESModule',path:'server/'+f})),compatibilityDate:'2026-08-01',
    d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{JOBS:'jobs'},
    serviceBindings:{ASSETS:async request=>{
      const name=new URL(request.url).pathname;
      const file=resolve('web','.'+(name==='/'?'/index.html':name));
      if(!file.startsWith(resolve('web')+sep))return new Response(null,{status:404});
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.m4a':'audio/mp4','.webp':'image/webp'};
      try{return new Response(readFileSync(file),{headers:{'Content-Type':types[extname(file)]||'application/octet-stream'}});}
      catch{return new Response(null,{status:404});}
    }},
    bindings:{VAULT_KEY:randomBytes(32).toString('hex'),RESEND_API_KEY:'fixture',RESEND_FROM:'post@example.test'},
    outboundService:async request=>{
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
    return {url:(await mf.ready).href,code:email=>inbox.get(email),
      advanceCooldown:email=>db.prepare('UPDATE email_challenges SET sent=sent-61 WHERE email=?').bind(email).run(),
      close:()=>mf.dispose()};
  }catch(error){await mf.dispose();throw error;}
}
