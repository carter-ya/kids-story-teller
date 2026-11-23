import {admin,ApiError,hash,json,readJson,requireValue,validProvider} from './common.mjs';
import {getSecret,shelf} from './family.mjs';
import {hasStyle,narrate,writeStory} from './providers.mjs';

const objectKey=(family,id)=>family+'/audio/'+id+'.wav';
const select=(env,family,id)=>env.DB.prepare('SELECT g.*, f.media_bytes AS family_media FROM generation g JOIN families f ON f.id=g.family WHERE g.family=? AND g.id=?').bind(family,id).first();
const publicJob=j=>({id:j.id,status:j.status,kind:j.kind,bytes:j.bytes,mediaBytes:j.family_media,duration:Math.max(0,(j.bytes-44)/48000),text:j.kind!=='voice'&&j.status==='done'?j.result:undefined,error:j.status==='failed'?j.result:undefined});
export async function submit(req,env,session){
  admin(session);requireValue(req.method==='POST',405,'请选择生成操作。');
  const {id,kind,provider,model='',style='',input}=await readJson(req);
  requireValue(typeof id==='string'&&/^[a-zA-Z0-9-]{12,64}$/.test(id),400,'无效的请求编号。');
  validProvider(provider);
  requireValue(['write','rewrite','voice'].includes(kind)&&typeof input==='string'&&input.trim()&&input.length<=(kind==='voice'?4000:2000),400,'写作想法最多 2000 字，单篇配音最多 4000 字。');
  requireValue(typeof model==='string'&&typeof style==='string'&&(kind==='voice'?hasStyle(style)&&model==='':/^[\w.:-]{1,100}$/.test(model)&&style===''),400,'请选择有效的模型或声音。');
  const fingerprint=await hash(JSON.stringify([kind,provider,model,style,input]));
  let job=await select(env,session.family,id);
  if(!job){
    await getSecret(env,session.family,provider);
    const budget=await env.DB.prepare('SELECT 100000000-content_bytes-media_bytes-reserved AS free FROM families WHERE id=?').bind(session.family).first();
    // Limit one recording to 32 MB to bound memory on a Workers isolate.
    const reserve=kind!=='voice'?64000:Math.min(budget.free,32000000);
    requireValue(reserve>=64000&&reserve<=budget.free,413,'家庭空间不足。');
    await env.DB.prepare('INSERT INTO generation(family,id,fingerprint,kind,provider,model,style,input,reserve) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM families WHERE id=? AND 100000000-content_bytes-media_bytes-reserved>=?) ON CONFLICT(family,id) DO NOTHING').bind(session.family,id,fingerprint,kind,provider,model,style,input,reserve,session.family,reserve).run();
    job=await select(env,session.family,id);requireValue(job,409,'家庭剩余空间已变化。');
  }
  requireValue(job.fingerprint===fingerprint,409,'这个任务编号已被使用。');
  if(job.status==='queued')await env.JOBS.send({family:session.family,id});
  return json(publicJob(job),202);
}
export async function runJob(env,{family,id}){
  const claimed=await env.DB.prepare("UPDATE generation SET status='running',touched=unixepoch() WHERE family=? AND id=? AND status='queued'").bind(family,id).run();
  if(!claimed.meta.changes)return;
  const job=await select(env,family,id);
  try{
    const key=await getSecret(env,family,job.provider);
    let bytes=0,result='';
    if(job.kind==='voice'){
      const blob=await narrate(job,key);bytes=blob.size;
      await env.FILES.put(objectKey(family,id),blob,{httpMetadata:{contentType:'audio/wav'}});
    }else{result=await writeStory(job,key);bytes=new TextEncoder().encode(result).length;}
    await env.DB.prepare("UPDATE generation SET status='done',input='',reserve=0,bytes=?,result=?,touched=unixepoch() WHERE family=? AND id=? AND status='running'").bind(bytes,result,family,id).run();
  }catch(e){
    const message=e instanceof ApiError?e.message:'生成中断。服务商可能已计费，确认后可重新生成。';
    await env.DB.prepare("UPDATE generation SET status='failed',input='',reserve=0,result=?,touched=unixepoch() WHERE family=? AND id=? AND status='running'").bind(message,family,id).run();
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
  await env.DB.prepare("UPDATE generation SET status='failed',input='',reserve=0,result='生成超时，服务商可能已计费，请确认后重试。',touched=unixepoch() WHERE status='running' AND touched<unixepoch()-1200").run();
  const old=await env.DB.prepare("SELECT family,id FROM generation WHERE status IN ('done','failed','deleting') AND touched<unixepoch()-86400 ORDER BY touched LIMIT 30").all();
  for(const j of old.results){
    const row=await shelf(env,j.family),s=row.state;
    const linked=s&&(Object.values(s.jobs||{}).some(job=>job.request===j.id)||s.stories.some(st=>st.recordings.some(r=>r.id===j.id)));
    if(linked){await env.DB.prepare('UPDATE generation SET touched=unixepoch() WHERE family=? AND id=?').bind(j.family,j.id).run();continue;}
    const claimed=await env.DB.prepare("UPDATE generation SET status='deleting' WHERE family=? AND id=? AND EXISTS(SELECT 1 FROM families WHERE id=? AND revision=?)").bind(j.family,j.id,j.family,row.revision).run();
    if(!claimed.meta.changes)continue;
    await env.FILES.delete(objectKey(j.family,j.id));
    await env.DB.prepare("DELETE FROM generation WHERE family=? AND id=? AND status='deleting'").bind(j.family,j.id).run();
  }
}
