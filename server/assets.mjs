import {admin,json,readJson,requireValue} from './common.mjs';
import {owner,accountList} from './accounts.mjs';
import {shelf} from './family.mjs';

const coverKey=(family,id)=>family+'/covers/'+id+'.webp';
export async function coverAsset(req,env,session,id){
  const family=session.family;
  if(req.method==='POST'&&!id){
    admin(session);
    requireValue(req.headers.get('Content-Type')==='image/webp',415,'请选择 WebP 图片。');
    const max=1000000, reader=req.body?.getReader();requireValue(reader,400,'缺少图片。');
    const parts=[];let size=0;
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.length;if(size>max){await reader.cancel();requireValue(false,413,'封面最多 1 MB。');}
      parts.push(value);
    }
    const data=new Uint8Array(await new Blob(parts).arrayBuffer());
    const tag=(a,b)=>String.fromCharCode(...data.slice(a,b));
    requireValue(data.length>=20&&tag(0,4)==='RIFF'&&tag(8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(tag(12,16)),400,'无效的 WebP 图片。');
    id=crypto.randomUUID();
    const r=await env.DB.prepare('INSERT INTO covers(family,id,bytes) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM families WHERE id=? AND content_bytes+media_bytes+reserved+?<=100000000)').bind(family,id,size,family,size).run();
    requireValue(r.meta.changes,413,'家庭空间不足。');
    try{await env.FILES.put(coverKey(family,id),data);}catch(e){await env.DB.prepare('DELETE FROM covers WHERE family=? AND id=?').bind(family,id).run();throw e;}
    return json({cover:'cover-'+id,bytes:size},201);
  }
  requireValue(req.method==='GET'&&id,405,'不支持此方法。');
  if(session.kid){
    const {state}=await shelf(env,family);
    requireValue(state?.people.some(p=>p.id===session.kid&&p.kind==='孩子')&&state.stories.some(s=>!s.archived&&s.published?.cover==='cover-'+id&&s.published.kids.includes(session.kid)),404,'找不到封面。');
  }
  const file=await env.FILES.get(coverKey(family,id));requireValue(file,404,'找不到封面。');
  return new Response(file.body,{headers:{'Content-Type':'image/webp','Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
}

function tarHeader(name,size){
  const b=new Uint8Array(512),write=(n,t)=>b.set(new TextEncoder().encode(t),n);
  write(0,name);write(100,'0000600');write(108,'0000000');write(116,'0000000');
  write(124,size.toString(8).padStart(11,'0'));write(136,'00000000000');
  b.fill(32,148,156);b[156]=48;write(257,'ustar');write(263,'00');
  write(148,b.reduce((n,x)=>n+x,0).toString(8).padStart(6,'0')+'\0 ');return b;
}
async function* archive(env,family,manifest,entries){
  const info=new TextEncoder().encode(JSON.stringify(manifest,null,2));
  yield tarHeader('family.json',info.length);yield info;yield new Uint8Array((512-info.length%512)%512);
  for(const {key,name} of entries){
    const obj=await env.FILES.get(family+'/'+key);requireValue(obj,503,'文件暂时不可用，请重新导出。');
    yield tarHeader(name,obj.size);
    for await(const chunk of obj.body)yield chunk;
    yield new Uint8Array((512-obj.size%512)%512);
  }
  yield new Uint8Array(1024);
}
export async function familyArchive(req,env,session){
  owner(session);requireValue(req.method==='GET',405,'不支持此方法。');
  const family=session.family,{state}=await shelf(env,family);
  const recordings=(await env.DB.prepare("SELECT id,provider,style,bytes FROM generation WHERE family=? AND kind='voice' AND status='done'").bind(family).all()).results;
  const covers=(await env.DB.prepare('SELECT id,bytes FROM covers WHERE family=?').bind(family).all()).results;
  const services=(await env.DB.prepare('SELECT id,owner,type,provider,model,shared,daily,monthly,per_story FROM service_configs WHERE family=?').bind(family).all()).results;
  const usage=(await env.DB.prepare('SELECT config,units,created FROM service_usage WHERE family=?').bind(family).all()).results;
  const entries=[...recordings.map(r=>'audio/'+r.id+'.wav'),...covers.map(c=>'covers/'+c.id+'.webp')].map(name=>({key:name,name}));
  const stream=archive(env,family,{version:1,state,adults:await accountList(env,family),services,usage,recordings,covers},entries);
  return new Response(new ReadableStream({async pull(controller){const r=await stream.next();if(r.done)controller.close();else controller.enqueue(r.value);},cancel(){return stream.return();}}),{headers:{'Content-Type':'application/x-tar','Content-Disposition':'attachment; filename="family-stories.tar"','Cache-Control':'no-store'}});
}
export async function eraseFamily(req,env,session){
  owner(session);requireValue(req.method==='DELETE',405,'不支持此方法。');
  const {confirm}=await readJson(req);requireValue(confirm==='删除整个家庭',400,'请填写完整确认文字。');
  const family=session.family;
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO erased_families VALUES(?,unixepoch(),unixepoch()+86400)').bind(family),
    ...['sessions','service_configs','adult_accounts','service_usage','generation','covers','credentials','chores'].map(t=>env.DB.prepare('DELETE FROM '+t+' WHERE family=?').bind(family)),
    env.DB.prepare('DELETE FROM families WHERE id=?').bind(family)
  ]);
  return json({deleted:true},200,{'Set-Cookie':'story_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
}
export async function collectAssets(env){
  const erased=(await env.DB.prepare('SELECT * FROM erased_families WHERE sweep<=unixepoch() ORDER BY sweep LIMIT 20').all()).results;
  for(const r of erased){
    const list=await env.FILES.list({prefix:r.family+'/',limit:200});
    if(list.objects.length)await env.FILES.delete(list.objects.map(x=>x.key));
    if(!list.truncated){
      await env.DB.prepare('DELETE FROM erased_families WHERE family=? AND expires<unixepoch()').bind(r.family).run();
      await env.DB.prepare('UPDATE erased_families SET sweep=unixepoch()+1800 WHERE family=?').bind(r.family).run();
    }
  }
  const old=(await env.DB.prepare('SELECT * FROM covers WHERE touched<unixepoch()-86400 ORDER BY touched LIMIT 20').all()).results;
  for(const c of old){
    const row=await shelf(env,c.family),name='cover-'+c.id;
    if(row.state?.stories.some(s=>s.cover===name||s.published?.cover===name)){
      await env.DB.prepare('UPDATE covers SET touched=unixepoch() WHERE family=? AND id=?').bind(c.family,c.id).run();continue;
    }
    const claimed=await env.DB.prepare('DELETE FROM covers WHERE family=? AND id=? AND EXISTS(SELECT 1 FROM families WHERE id=? AND revision=?)').bind(c.family,c.id,c.family,row.revision).run();
    if(claimed.meta.changes)await env.FILES.delete(coverKey(c.family,c.id));
  }
}
