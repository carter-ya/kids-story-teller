import {admin,ApiError,hash,json,newToken,readJson,requireValue,validProvider} from './common.mjs';

const ttl=14*86400;
function cookie(req,value,age) {
  const secure=new URL(req.url).protocol==='https:'?'; Secure':'';
  return 'story_session='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+age+secure;
}
export async function sessionFor(req,env) {
  const token=req.headers.get('Cookie')?.match(/(?:^|;\s*)story_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!token)return null;
  return env.DB.prepare('SELECT * FROM sessions WHERE token=? AND expires>unixepoch()').bind(await hash(token)).first();
}
async function sessionResponse(req,env,family,kid,old,extra={}){
  const token=newToken();
  const batch=[env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,unixepoch()+?)').bind(await hash(token),family,kid,ttl)];
  if(old)batch.push(env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(old.token));
  await env.DB.batch(batch);
  return json({family,kid,...extra},200,{'Set-Cookie':cookie(req,token,ttl)});
}
export async function apiSession(req,env,path,session){
  if(path==='/api/session'&&req.method==='GET')return json({cloud:true,family:session?.family||null,kid:session?.kid||null});
  if(req.method!=='POST')return;
  if(path==='/api/session/create'){
    const id=crypto.randomUUID(),pass='story-'+newToken();
    await env.DB.prepare('INSERT INTO families(id,pass_hash) VALUES(?,?)').bind(id,await hash(pass)).run();
    return sessionResponse(req,env,id,null,session,{pass});
  }
  if(path==='/api/session/login'){
    const {pass}=await readJson(req);
    requireValue(typeof pass==='string' && /^story-[a-f0-9]{64}$/.test(pass),401,'家庭登录码不正确。');
    const family=await env.DB.prepare('SELECT id FROM families WHERE pass_hash=?').bind(await hash(pass)).first();
    requireValue(family,401,'家庭登录码不正确。');
    return sessionResponse(req,env,family.id,null,session);
  }
  if(path==='/api/session/logout'){
    if(session)await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(session.token).run();
    return json({},200,{'Set-Cookie':cookie(req,'',0)});
  }
  if(path==='/api/session/child'){
    admin(session);const {kid}=await readJson(req);
    const {state}=await shelf(env,session.family);
    requireValue(state?.people.some(p=>p.kind==='孩子'&&p.id===kid),404,'找不到听众。');
    return sessionResponse(req,env,session.family,kid,session);
  }
}
export async function shelf(env,family){
  const row=await env.DB.prepare('SELECT revision,shelf_key,media_bytes,reserved FROM families WHERE id=?').bind(family).first();
  requireValue(row,404,'家庭不存在。');
  const object=row.shelf_key?await env.FILES.get(row.shelf_key):null;
  requireValue(!row.shelf_key||object,503,'暂时无法读取书架。');
  return {...row,state:object?await object.json():null};
}
function childView(s,kid){
  if(!s)return null;
  requireValue(s.people.some(p=>p.id===kid&&p.kind==='孩子'),403,'听众已移除。');
  const records=s.stories.filter(x=>!x.archived&&x.published?.kids.includes(kid)).map(x=>{
    const r=x.recordings.find(r=>r.id===x.published.rid);
    if(!r)return null;
    return {id:x.id,title:x.published.title||r.title,series:x.series,archived:false,
      published:{...x.published,kids:[kid]},recordings:[r]};
  }).filter(Boolean);
  return {version:1,kid,people:s.people.filter(p=>p.id===kid),stories:records,configs:[],jobs:{},usage:[],
    prefs:{[kid]:s.prefs?.[kid]||{}},favorites:{[kid]:s.favorites?.[kid]||[]},progress:Object.fromEntries(Object.entries(s.progress||{}).filter(([key])=>key.startsWith(kid+':')))};
}
function validateShelf(s){
  requireValue(s && Array.isArray(s.people)&&s.people.length>0&&s.people.length<=20,400,'每个家庭最多 20 人。');
  requireValue(Array.isArray(s.stories)&&s.stories.length<=100,400,'每个家庭最多 100 篇故事。');
  const ids=values=>values.every(x=>typeof x?.id==='string' && /^[\w-]{1,96}$/.test(x.id))&&new Set(values.map(x=>x.id)).size===values.length;
  requireValue(ids(s.people)&&ids(s.stories)&&s.people.every(p=>['成人','孩子'].includes(p.kind)&&typeof p.name==='string'),400,'无效的成员或故事。');
  requireValue(Array.isArray(s.configs)&&s.configs.every(c=>c && !['key','apiKey','secret','pass'].some(k=>k in c)),400,'凭据必须使用密钥接口。');
  for(const s1 of s.stories)requireValue(Array.isArray(s1.recordings)&&ids(s1.recordings)&&Array.isArray(s1.versions)&&typeof s1.text==='string'&&typeof s1.title==='string',400,'无效的故事版本。');
}
export async function saveShelf(env,family,revision,state){
  validateShelf(state);
  const payload=JSON.stringify(state),size=new TextEncoder().encode(payload).length;
  const previous=await env.DB.prepare('SELECT revision,shelf_key,media_bytes,reserved FROM families WHERE id=?').bind(family).first();
  requireValue(previous.revision===revision,409,'另一台设备已修改书架，请重新载入后再编辑。');
  requireValue(size+previous.media_bytes+previous.reserved<=100000000,413,'家庭空间不足。');
  const key=family+'/shelves/'+crypto.randomUUID();
  // A delayed garbage-collection record also covers interrupted writes.
  await env.DB.prepare('INSERT INTO chores VALUES(?,?,unixepoch()+86400)').bind(key,family).run();
  await env.FILES.put(key,payload);
  const changed=await env.DB.prepare('UPDATE families SET revision=revision+1,shelf_key=?,content_bytes=? WHERE id=? AND revision=? AND ?+reserved+media_bytes<=100000000').bind(key,size,family,revision,size).run();
  requireValue(changed.meta.changes===1,409,'书架版本或剩余空间已变化，请重新载入。');
  return revision+1;
}
export async function apiShelf(req,env,session){
  if(req.method==='GET'){
    const row=await shelf(env,session.family);
    return json({revision:row.revision,state:session.kid?childView(row.state,session.kid):row.state,mediaBytes:row.media_bytes});
  }
  if(req.method==='PUT'){
    admin(session);const {revision,state}=await readJson(req,8000000);
    return json({revision:await saveShelf(env,session.family,revision,state)});
  }
  if(req.method==='PATCH'){
    const {id,favorite,progress}=await readJson(req);const kid=session.kid;
    requireValue(kid&&typeof id==='string'&&id.length<=96,400,'无效的听众操作。');
    const {revision,state}=await shelf(env,session.family);
    requireValue(state?.people.some(p=>p.id===kid&&p.kind==='孩子'),403,'听众已移除。');
    const item=state.stories.find(s=>s.id===id&&!s.archived&&s.published?.kids.includes(kid));
    requireValue(item||['fox','rabbit','bear'].includes(id),404,'找不到这篇故事。');
    state.favorites??={};state.progress??={};
    if(typeof favorite==='boolean'){
      const set=new Set(state.favorites[kid]||[]);if(favorite)set.add(id);else set.delete(id);state.favorites[kid]=[...set];
    }
    if(Number.isFinite(progress)&&progress>=0)state.progress[[kid,id,item?.published.rid||'sample'].join(':')]={pos:progress,at:Date.now()};
    return json({revision:await saveShelf(env,session.family,revision,state)});
  }
  throw new ApiError(405,'不支持此方法。');
}
async function vaultKey(env){
  requireValue(typeof env.VAULT_KEY==='string'&&/^[a-f0-9]{64}$/i.test(env.VAULT_KEY),503,'服务器尚未配置凭据加密。');
  return crypto.subtle.importKey('raw',Uint8Array.from(env.VAULT_KEY.match(/../g),x=>parseInt(x,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
const aad=(family,provider)=>new TextEncoder().encode(family+'/'+provider);
export async function getSecret(env,family,provider){
  const row=await env.DB.prepare('SELECT encrypted FROM credentials WHERE family=? AND provider=?').bind(family,provider).first();
  requireValue(row,422,'请先为这个服务商保存 API Key。');
  const b=Uint8Array.from(atob(row.encrypted),c=>c.charCodeAt(0));
  const value=await crypto.subtle.decrypt({name:'AES-GCM',iv:b.slice(0,12),additionalData:aad(family,provider)},await vaultKey(env),b.slice(12));
  return new TextDecoder().decode(value);
}
export async function credentials(req,env,session,provider){
  admin(session);validProvider(provider);
  if(req.method==='GET'){
    const row=await env.DB.prepare('SELECT 1 AS ok FROM credentials WHERE family=? AND provider=?').bind(session.family,provider).first();
    return json({configured:!!row});
  }
  if(req.method==='DELETE'){
    await env.DB.prepare('DELETE FROM credentials WHERE family=? AND provider=?').bind(session.family,provider).run();return json({});
  }
  requireValue(req.method==='PUT',405,'不支持此方法。');
  const {key}=await readJson(req,4096);
  requireValue(typeof key==='string'&&/^[!-~]{8,512}$/.test(key),400,'请输入完整的 API Key。');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(session.family,provider)},await vaultKey(env),new TextEncoder().encode(key)));
  await env.DB.prepare('INSERT INTO credentials VALUES(?,?,?) ON CONFLICT(family,provider) DO UPDATE SET encrypted=excluded.encrypted').bind(session.family,provider,btoa(String.fromCharCode(...iv,...encrypted))).run();
  return json({configured:true});
}
export async function collectShelves(env){
  const rows=await env.DB.prepare('SELECT * FROM chores WHERE after<=unixepoch() LIMIT 50').all();
  for(const r of rows.results){
    const current=await env.DB.prepare('SELECT shelf_key FROM families WHERE id=?').bind(r.family).first();
    if(current?.shelf_key===r.object_key){
      await env.DB.prepare('UPDATE chores SET after=unixepoch()+86400 WHERE object_key=?').bind(r.object_key).run();
    }else{
      await env.FILES.delete(r.object_key);
      await env.DB.prepare('DELETE FROM chores WHERE object_key=?').bind(r.object_key).run();
    }
  }
  await env.DB.prepare('DELETE FROM sessions WHERE expires<unixepoch()').run();
}
