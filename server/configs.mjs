import {admin,json,readJson,requireValue,validProvider} from './common.mjs';
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
  if(c.key){
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
