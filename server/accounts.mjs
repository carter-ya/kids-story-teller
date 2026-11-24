import {shelf} from './family.mjs';
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
    const row=await env.DB.prepare('SELECT personal_login,profile_count FROM families WHERE id=?').bind(session.family).first();
    requireValue(row.personal_login,409,'请先为旧家庭绑定邮箱。');
    // Older families started with a conservative count until their first shelf edit.
    if(row.profile_count===20){
      const current=await shelf(env,session.family);
      await env.DB.prepare('UPDATE families SET profile_count=? WHERE id=? AND revision=?').bind(
        current.state?.people.length||2,session.family,current.revision).run();
    }
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
