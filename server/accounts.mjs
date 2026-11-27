import {admin,hash,json,newToken,readJson,requireValue} from './common.mjs';

export function owner(session){
  admin(session);requireValue(session.adult==='owner',403,'请由家庭管理员操作。');
}
export async function accountList(env,family){
  return (await env.DB.prepare("SELECT id,name,pending FROM adult_accounts WHERE family=? AND (pending=0 OR expires>unixepoch()) ORDER BY name,id").bind(family).all()).results;
}
export async function accounts(req,env,session,id){
  owner(session);
  if(req.method==='POST'&&!id){
    const {name}=await readJson(req);
    requireValue(typeof name==='string'&&name.trim()&&name.trim().length<=24,400,'请填写昵称。');
    const code='invite-'+newToken();
    await env.DB.prepare('INSERT INTO adult_accounts VALUES(?,?,?,?,1,unixepoch()+86400)').bind(session.family,crypto.randomUUID(),name.trim(),await hash(code)).run();
    return json({code});
  }
  if(req.method==='DELETE'&&id){
    await env.DB.batch([
      env.DB.prepare('DELETE FROM adult_accounts WHERE family=? AND id=?').bind(session.family,id),
      env.DB.prepare('DELETE FROM sessions WHERE family=? AND adult=?').bind(session.family,id),
      env.DB.prepare('DELETE FROM service_configs WHERE family=? AND owner=?').bind(session.family,id)
    ]);
    return json({});
  }
  requireValue(false,405,'不支持此方法。');
}
