import {collectShelves} from './family.mjs';
import {maintainJobs} from './generation.mjs';
import {collectAssets} from './assets.mjs';

const interval=600;
let nextProbe=0;
export async function wakeMaintenance(env){
  if(Date.now()<nextProbe)return;
  nextProbe=Date.now()+60000;
  // A visit bootstraps a new database or restarts a chain after a queue outage.
  const row=await env.DB.prepare('UPDATE maintenance SET wake_after=unixepoch()+90 WHERE id=1 AND due<=unixepoch() AND wake_after<=unixepoch() AND lease_until<=unixepoch() RETURNING tick').first();
  if(row)await env.JOBS.send({maintenance:row.tick});
}
export async function clean(env){
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_challenges WHERE sent<=unixepoch()-600'),
    env.DB.prepare('DELETE FROM email_send_limits WHERE expires<=unixepoch()')
  ]);
  await collectAssets(env);await collectShelves(env);await maintainJobs(env);
}
export async function maintenanceMessage(env,message){
  const tick=message.body.maintenance;
  const claimed=await env.DB.prepare('UPDATE maintenance SET lease_until=unixepoch()+60 WHERE id=1 AND tick=? AND lease_until<=unixepoch()').bind(tick).run();
  if(!claimed.meta.changes){
    const current=await env.DB.prepare('SELECT tick FROM maintenance WHERE id=1').first();
    if(current.tick===tick)message.retry({delaySeconds:65});else message.ack();
    return;
  }
  try{
    // Send before advancing. A retried or duplicated successor is harmless.
    await env.JOBS.send({maintenance:tick+1},{delaySeconds:interval});
    const advanced=await env.DB.prepare('UPDATE maintenance SET tick=tick+1,due=unixepoch()+?,wake_after=unixepoch()+?,lease_until=0 WHERE id=1 AND tick=?').bind(interval,interval+90,tick).run();
    if(advanced.meta.changes){
      await clean(env);
      await env.DB.prepare('UPDATE maintenance SET last_success=unixepoch() WHERE id=1').run();
    }
    message.ack();
  }catch(error){
    await env.DB.prepare('UPDATE maintenance SET lease_until=0 WHERE id=1 AND tick=?').bind(tick).run();
    throw error;
  }
}
