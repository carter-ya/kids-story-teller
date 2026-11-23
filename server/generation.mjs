import {serviceFor,keyForConfig} from './configs.mjs';
import {admin,ApiError,hash,json,readJson,requireValue,validProvider} from './common.mjs';
import {getSecret,shelf} from './family.mjs';
import {hasStyle,narrate,writeStory} from './providers.mjs';

const objectKey=(family,id)=>family+'/audio/'+id+'.wav';
const select=(env,family,id)=>env.DB.prepare('SELECT g.*, f.media_bytes AS family_media FROM generation g JOIN families f ON f.id=g.family WHERE g.family=? AND g.id=?').bind(family,id).first();
const publicJob=j=>({id:j.id,status:j.status,completed:j.completed||0,retryable:j.kind==='voice'&&!!j.input,kind:j.kind,bytes:j.bytes,mediaBytes:j.family_media,duration:Math.max(0,(j.bytes-44)/48000),text:j.kind!=='voice'&&j.status==='done'?j.result:undefined,error:j.status==='failed'?j.result:undefined});
export async function submit(req,env,session){
  admin(session);requireValue(req.method==='POST',405,'请选择生成操作。');
  const {id,kind,provider,model='',style='',input,config='',listener=''}=await readJson(req);
  requireValue(typeof id==='string'&&/^[a-zA-Z0-9-]{12,64}$/.test(id),400,'无效的请求编号。');
  validProvider(provider);
  requireValue(['write','rewrite','voice'].includes(kind)&&typeof input==='string'&&input.trim()&&input.length<=(kind==='voice'?4000:2000),400,'写作想法最多 2000 字，单篇配音最多 4000 字。');
  requireValue(typeof model==='string'&&typeof style==='string'&&(kind==='voice'?hasStyle(style)&&model==='':/^[\w.:-]{1,100}$/.test(model)&&style===''),400,'请选择有效的模型或声音。');
  const actor=session.adult;
  const fingerprint=await hash(JSON.stringify(config||listener?[kind,provider,model,style,input,config,listener]:[kind,provider,model,style,input]));
  let job=await select(env,session.family,id);
  if(!job){
    let endpoint='';
    if(config){
      const c=await serviceFor(env,session.family,config,actor);
      requireValue(c.provider===provider&&c.model===model&&c.type===(kind==='voice'?'voice':'write'),409,'模型配置已改变。');
      endpoint=c.endpoint;
    }else{
      requireValue(actor==='owner',403,'请选择自己拥有或获授权的配置。');
      await getSecret(env,session.family,provider);
    }
    const prefs=listener&&kind!=='voice'?(await shelf(env,session.family)).state?.prefs?.[listener]:null;
    const settings=JSON.stringify({endpoint,age:String(prefs?.age||'').slice(0,24),avoid:String(prefs?.avoid||'').slice(0,160)});
    const budget=await env.DB.prepare('SELECT 100000000-content_bytes-media_bytes-reserved AS free FROM families WHERE id=?').bind(session.family).first();
    // Limit one recording to 32 MB to bound memory on a Workers isolate.
    const reserve=kind!=='voice'?64000:Math.min(budget.free,32000000);
    requireValue(reserve>=64000&&reserve<=budget.free,413,'家庭空间不足。');
    try{await env.DB.prepare('INSERT INTO generation(family,id,fingerprint,kind,provider,model,style,input,reserve,actor,config,settings) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM families WHERE id=? AND 100000000-content_bytes-media_bytes-reserved>=?) ON CONFLICT(family,id) DO NOTHING').bind(session.family,id,fingerprint,kind,provider,model,style,input,reserve,actor,config,settings,session.family,reserve).run();}catch(e){
      if(String(e.message).includes('service_budget')||String(e.cause?.message).includes('service_budget'))throw new ApiError(429,'本服务已达到用量限制，请查看每日次数、单篇及每月字数。');
      throw e;
    }
    job=await select(env,session.family,id);requireValue(job,409,'家庭剩余空间已变化。');
  }
  requireValue(job.actor===actor,403,'任务属于另一位家长。');
  requireValue(job.fingerprint===fingerprint,409,'这个任务编号已被使用。');
  if(job.status==='queued')await env.JOBS.send({family:session.family,id});
  return json(publicJob(job),202);
}
const partKey=(f,id,i)=>f+'/parts/'+id+'/'+i+'.pcm';
async function discardParts(env,family,id){
  const list=await env.FILES.list({prefix:family+'/parts/'+id+'/'});
  if(list.objects.length)await env.FILES.delete(list.objects.map(p=>p.key));
}
export async function retryVoice(req,env,session,id){
  admin(session);requireValue(req.method==='POST',405,'不支持此方法。');
  const {attempt}=await readJson(req);
  requireValue(typeof attempt==='string'&&/^[a-zA-Z0-9-]{12,64}$/.test(attempt),400,'无效的重试编号。');
  let job=await select(env,session.family,id);
  requireValue(job?.actor===session.adult&&job.kind==='voice',403,'不能重试这个任务。');
  if(job.retry_token!==attempt){
    requireValue(job.status==='failed'&&job.input,409,'此任务暂不可重试。');
    if(job.config)await serviceFor(env,session.family,job.config,session.adult);
    const budget=await env.DB.prepare('SELECT 100000000-content_bytes-media_bytes-reserved AS free FROM families WHERE id=?').bind(session.family).first();
    const reserve=Math.min(32000000-job.bytes,budget.free);requireValue(reserve>=44,413,'空间不足。');
    try{
      const r=await env.DB.prepare("UPDATE generation SET retry_token=?,status='queued',reserve=?,remaining_chars=CASE WHEN completed=0 THEN length(input) ELSE remaining_chars END,touched=unixepoch() WHERE family=? AND id=? AND status='failed' AND EXISTS(SELECT 1 FROM families WHERE id=? AND content_bytes+media_bytes+reserved+?<=100000000)").bind(attempt,reserve,session.family,id,session.family,reserve).run();
      requireValue(r.meta.changes,409,'任务或空间已变化。');
    }catch(e){if(String(e.message).includes('service_budget'))throw new ApiError(429,'已达到服务用量上限。');throw e;}
    job=await select(env,session.family,id);
  }
  if(job.status==='queued')await env.JOBS.send({family:session.family,id});
  return json(publicJob(job));
}
export async function runJob(env,{family,id}){
  const claimed=await env.DB.prepare("UPDATE generation SET status='running',touched=unixepoch() WHERE family=? AND id=? AND status='queued'").bind(family,id).run();
  if(!claimed.meta.changes)return;
  const job=await select(env,family,id);
  try{
    Object.assign(job,JSON.parse(job.settings));
    let key;
    if(job.config){
      const c=await serviceFor(env,family,job.config,job.actor);
      requireValue(c.endpoint===job.endpoint&&c.provider===job.provider&&c.model===job.model,409,'排队期间配置已更改，请重新确认。');
      key=await keyForConfig(env,family,c);
    }else key=await getSecret(env,family,job.provider);
    let bytes=0,result='';
    if(job.kind==='voice'){
      const checkpoints={
        async load(i){
          const object=await env.FILES.get(partKey(family,id,i));
          requireValue(object,503,'已保存的片段暂时不可读。');
          return new Blob([await object.arrayBuffer()]);
        },
        async save(i,chunk,remaining){
          await env.FILES.put(partKey(family,id,i),chunk);
          const r=await env.DB.prepare("UPDATE generation SET completed=?,remaining_chars=?,bytes=bytes+?,reserve=reserve-?,touched=unixepoch() WHERE family=? AND id=? AND status='running' AND completed=?").bind(i+1,remaining,chunk.size,chunk.size,family,id,i).run();
          requireValue(r.meta.changes,409,'任务已结束。');
        }
      };
      const blob=await narrate(job,key,fetch,checkpoints);bytes=blob.size;
      await env.FILES.put(objectKey(family,id),blob,{httpMetadata:{contentType:'audio/wav'}});
    }else{result=await writeStory(job,key);bytes=new TextEncoder().encode(result).length;}
    await env.DB.prepare("UPDATE generation SET status='done',input='',reserve=0,bytes=?,result=?,touched=unixepoch() WHERE family=? AND id=? AND status='running'").bind(bytes,result,family,id).run();
    if(job.kind==='voice')await discardParts(env,family,id);
  }catch(e){
    const message=e instanceof ApiError?e.message:'生成中断。服务商可能已计费，确认后可重新生成。';
    await env.DB.prepare("UPDATE generation SET status='failed',reserve=0,result=?,touched=unixepoch() WHERE family=? AND id=? AND status='running'").bind(message,family,id).run();
  }
}
export async function generation(req,env,session,id,audio){
  const family=session.family;
  if(!audio)admin(session);
  requireValue(['GET','HEAD'].includes(req.method),405,'不支持此方法。');
  const j=await select(env,family,id);requireValue(j,404,'找不到任务。');
  if(!audio)return json(publicJob(j));
  requireValue(j.kind==='voice'&&j.status==='done',404,'找不到录音。');
  if(session.kid){
    const {state}=await shelf(env,family);
    requireValue(state?.people.some(p=>p.id===session.kid&&p.kind==='孩子')&&state.stories.some(s=>!s.archived&&s.published?.rid===id&&s.published.kids.includes(session.kid)),404,'找不到录音。');
  }
  const headers={'Content-Type':'audio/wav','Cache-Control':'private, no-store','Accept-Ranges':'bytes'};
  let start=0,end=j.bytes-1,status=200;
  const range=req.headers.get('Range');
  if(range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+j.bytes}});
    start=m[1]?Number(m[1]):Math.max(0,j.bytes-Number(m[2]));end=m[1]&&m[2]?Math.min(end,Number(m[2])):end;
    if(start>end||start>=j.bytes)return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+j.bytes}});
    status=206;headers['Content-Range']='bytes '+start+'-'+end+'/'+j.bytes;
  }
  const length=end-start+1;headers['Content-Length']=String(length);
  if(req.method==='HEAD')return new Response(null,{status,headers});
  const file=await env.FILES.get(objectKey(family,id),{range:{offset:start,length}});
  requireValue(file,503,'录音暂时不可用。');return new Response(file.body,{status,headers});
}
export async function maintainJobs(env){
  const pending=await env.DB.prepare("SELECT family,id FROM generation WHERE status='queued' AND touched<unixepoch()-60 LIMIT 40").all();
  for(const job of pending.results)await env.JOBS.send(job);
  await env.DB.prepare("UPDATE generation SET status='failed',reserve=0,result='生成超时，服务商可能已计费，请确认后重试。',touched=unixepoch() WHERE status='running' AND touched<unixepoch()-1200").run();
  const old=await env.DB.prepare("SELECT family,id FROM generation WHERE status IN ('done','failed','deleting') AND touched<unixepoch()-86400 ORDER BY touched LIMIT 30").all();
  for(const j of old.results){
    const row=await shelf(env,j.family),s=row.state;
    const linked=s&&(Object.values(s.jobs||{}).some(job=>job.request===j.id)||s.stories.some(st=>st.failedVoice?.request===j.id||st.recordings.some(r=>r.id===j.id)));
    if(linked){await env.DB.prepare('UPDATE generation SET touched=unixepoch() WHERE family=? AND id=?').bind(j.family,j.id).run();continue;}
    const claimed=await env.DB.prepare("UPDATE generation SET status='deleting' WHERE family=? AND id=? AND EXISTS(SELECT 1 FROM families WHERE id=? AND revision=?)").bind(j.family,j.id,j.family,row.revision).run();
    if(!claimed.meta.changes)continue;
    await discardParts(env,j.family,j.id);
    await env.FILES.delete(objectKey(j.family,j.id));
    await env.DB.prepare("DELETE FROM generation WHERE family=? AND id=? AND status='deleting'").bind(j.family,j.id).run();
  }
}
