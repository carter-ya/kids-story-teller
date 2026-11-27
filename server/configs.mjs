import {admin,ApiError,json,readJson,requireValue,validProvider} from './common.mjs';
import {encrypt,decrypt} from './family.mjs';

export function baseURL(provider){return 'https://api.'+provider+'.com/v1';}
function publicAddress(address){
  if(address.includes(':'))return /^[23][a-f0-9]{3}:/i.test(address)&&!/^2001:(?:db8|0*:|2:|10:|20:)/i.test(address)&&!/^2002:/i.test(address);
  const octets=address.split('.').map(Number);const [a,b,c]=octets;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)&&octets.every(n=>n<=255)&&a>0&&a<224&&![10,127].includes(a)
    &&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)
    &&!(a===192&&(b===168||(b===0&&[0,2].includes(c))||(b===88&&c===99)))&&!(a===198&&([18,19].includes(b)||(b===51&&c===100)))&&!(a===203&&b===0&&c===113);
}
async function approvedEndpoint(raw,provider,env){
  let url;try{url=new URL(raw||baseURL(provider));}catch{}
  requireValue(url&&url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,400,'请填写 HTTPS 服务根地址。');
  const origins=[new URL(baseURL(provider)).origin,...(env.PROVIDER_ORIGINS||'').split(',').map(x=>x.trim())];
  if(!origins.includes(url.origin)){
    requireValue(env.PUBLIC_PROVIDER_GATEWAYS==='1'&&!url.port&&/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(url.hostname),400,'请使用公网 HTTPS 域名。私网预览使用管理员批准的网关。');
    const addresses=await Promise.all(['A','AAAA'].map(async type=>{
      const dns=new URL('https://cloudflare-dns.com/dns-query');dns.searchParams.set('name',url.hostname);dns.searchParams.set('type',type);
      const res=await fetch(dns,{headers:{accept:'application/dns-json'},redirect:'manual',signal:AbortSignal.timeout(6000)});
      requireValue(res.ok,503,'暂时无法验证服务域名。');
      const answer=await res.json();requireValue(answer.Status===0,400,'服务域名无法解析。');
      return (answer.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>a.data);
    }));
    requireValue(addresses.flat().length&&addresses.flat().every(publicAddress),400,'服务域名必须只解析到公网地址。');
  }
  return url.href.replace(/\/+$/,'');
}
const fields='id, owner, provider, type, endpoint, model, shared AS share, daily AS perDay, monthly AS perMonth, per_story AS perStory';
export async function configs(req,env,session,id){
  admin(session);const {family,adult}=session;
  if(req.method==='GET')return json((await env.DB.prepare('SELECT '+fields+' FROM service_configs WHERE family=? AND (owner=? OR shared=1) ORDER BY rowid').bind(family,adult).all()).results);
  requireValue(id&&/^[\w-]{1,96}$/.test(id),400,'无效配置编号。');
  const existing=await env.DB.prepare('SELECT * FROM service_configs WHERE family=? AND id=?').bind(family,id).first();
  requireValue(!existing||existing.owner===adult,403,'只有凭据持有人可以更改配置。');
  if(req.method==='DELETE'){
    await env.DB.prepare('DELETE FROM service_configs WHERE family=? AND id=? AND owner=?').bind(family,id,adult).run();
    return json({});
  }
  requireValue(req.method==='PUT',405,'不支持此方法。');
  const c=await readJson(req,8192);validProvider(c.provider);
  requireValue(['voice','write'].includes(c.type)&&typeof c.model==='string'&&(c.type==='voice'?c.model==='':/^[\w.:-]{1,100}$/.test(c.model)),400,'请选择声音或输入有效模型。');
  const endpoint=await approvedEndpoint(c.endpoint,c.provider,env);
  const limits=[c.perDay,c.perMonth,c.perStory].map(x=>Number(x||0));
  requireValue(limits.every(x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000000),400,'用量上限须为非负整数。');
  let encrypted=existing?.encrypted;
  if(c.keyFrom!==undefined){
    requireValue(!c.key&&typeof c.keyFrom==='string'&&/^[\w-]{1,96}$/.test(c.keyFrom),400,'请选择一个已保存的密钥。');
    const source=await env.DB.prepare('SELECT id, endpoint, encrypted FROM service_configs WHERE family=? AND owner=? AND id=? AND provider=? AND endpoint=?').bind(family,adult,c.keyFrom,c.provider,endpoint).first();
    requireValue(source,400,'所选密钥已不可用，请选择本人在同一服务地址保存的配置。');
    encrypted=await encrypt(env,family,id+'@'+endpoint,await keyForConfig(env,family,source));
  }else if(c.key){
    requireValue(typeof c.key==='string'&&/^[!-~]{8,512}$/.test(c.key),400,'请填写完整密钥。');
    encrypted=await encrypt(env,family,id+'@'+endpoint,c.key);
  }else requireValue(encrypted&&existing.endpoint===endpoint&&existing.provider===c.provider,400,'首次连接或更换地址时请重新输入密钥。');
  const updated=await env.DB.prepare('INSERT INTO service_configs VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(family,id) DO UPDATE SET provider=excluded.provider,type=excluded.type,endpoint=excluded.endpoint,model=excluded.model,shared=excluded.shared,daily=excluded.daily,monthly=excluded.monthly,per_story=excluded.per_story,encrypted=excluded.encrypted WHERE owner=excluded.owner').bind(family,id,adult,c.provider,c.type,endpoint,c.model,c.share===true?1:0,...limits,encrypted).run();
  requireValue(updated.meta.changes,409,'配置已变化。');return json({id});
}
export async function serviceFor(env,family,id,actor){
  const c=await env.DB.prepare("SELECT * FROM service_configs WHERE family=? AND id=? AND (owner=? OR shared=1) AND (?='owner' OR EXISTS(SELECT 1 FROM adult_accounts WHERE family=? AND id=? AND pending=0))").bind(family,id,actor,actor,family,actor).first();
  requireValue(c,403,'此服务未授权或已移除。');await approvedEndpoint(c.endpoint,c.provider,env);
  return c;
}
export async function keyForConfig(env,family,c){
  return decrypt(env,family,c.id+'@'+c.endpoint,Uint8Array.from(atob(c.encrypted),x=>x.charCodeAt(0)));
}

export async function checkConfig(req,env,session,id){
  admin(session);requireValue(req.method==='POST',405,'不支持此方法。');
  const c=await serviceFor(env,session.family,id,session.adult);
  const key=await keyForConfig(env,session.family,c);
  const host=new URL(c.endpoint).host;
  const use=c.type==='voice'?'配音':'写作';
  const signal=AbortSignal.timeout(12000);
  async function lookup(path){
    try{return await fetch(c.endpoint+path,{headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'manual',signal});}
    catch{throw new ApiError(502,'连接 '+host+' 超时或网络不可用，请稍后重试。');}
  }
  async function checkDenial(response){
    const prefix=host+'（HTTP '+response.status+'）';
    if(response.status===401||response.status===403){
      const info=await readJson(response,8192).catch(()=>null);
      // Some gateways echo credentials in their messages. Only use known codes.
      const codes=[info?.error?.code,info?.error?.type,info?.code];
      if(codes.includes('unsupported_country_region_territory'))throw new ApiError(422,prefix+'：服务商拒绝了来自当前地区的请求。');
      if(response.status!==401 && codes.includes('invalid_api_key'))throw new ApiError(422,prefix+'：服务商报告此配置的 API Key 无效，请核对签发平台和服务地址。');
    }
    if(response.status===401)throw new ApiError(422,prefix+'：服务商未接受这条'+use+'配置的身份凭据。请核对 API 根地址和密钥是否来自同一平台。');
    if(response.status===402)throw new ApiError(422,prefix+'：服务商账户余额不足。');
    if(response.status===429)throw new ApiError(429,prefix+'：已达到服务商用量或并发限制。');
  }
  const response=await lookup('/models');
  if(!response.ok){
    await checkDenial(response);
    const prefix=host+'（HTTP '+response.status+'）';
    if(![403,404,405].includes(response.status))throw new ApiError(422,prefix+'：无法读取模型列表，请核对服务地址及兼容协议。');
    if(c.type==='write' && c.model!=='.' && c.model!=='..'){
      const model=await lookup('/models/'+encodeURIComponent(c.model));
      if(model.ok && (await model.json().catch(()=>null))?.id===c.model){
        return json({message:host+' 已返回写作模型 '+c.model+' 的资料。'});
      }
      if(!model.ok)await checkDenial(model);
    }
    const reason=response.status===403?'服务商拒绝读取模型列表':'此地址未提供模型列表';
    const next=c.type==='voice'?'可在工作台试听一句验证配音权限。':'请核对服务地址和模型查询权限。';
    throw new ApiError(422,prefix+'：'+reason+'，此次检查未验证'+use+'权限。'+next);
  }
  const answer=await response.json().catch(()=>null);
  requireValue(Array.isArray(answer?.data),422,host+' 返回了无法识别的模型列表，请核对 API 根地址。');
  if(c.type==='write')requireValue(answer.data.some(m=>m?.id===c.model),422,host+' 的模型列表中没有 '+c.model+'，请核对模型名称及权限。');
  return json({message:c.type==='write'?host+' 的模型列表包含 '+c.model+'。':host+' 的模型列表可读取。可在工作台试听一句验证配音权限。'});
}
