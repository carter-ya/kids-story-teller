import {hash,json,newToken,readJson,requireValue} from './common.mjs';

const lifetime = 600;
const invalidCode = '验证码不正确或已失效，请检查邮件或重新获取。';

async function signature(env, text) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',encoder.encode(env.VAULT_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes = await crypto.subtle.sign('HMAC',key,encoder.encode(text));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}

function newCode() {
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4294000000);
  return String(random[0] % 1000000).padStart(6,'0');
}

async function reserve(db,bucket,period,limit) {
  const row = await db.prepare(`INSERT INTO email_send_limits VALUES(?,unixepoch()+?,1)
    ON CONFLICT(bucket) DO UPDATE SET used=CASE WHEN expires<=unixepoch() THEN 1 ELSE used+1 END,
    expires=CASE WHEN expires<=unixepoch() THEN excluded.expires ELSE expires END
    WHERE expires<=unixepoch() OR used<? RETURNING used`).bind(bucket,period,limit).first();
  requireValue(row,429,'发送次数已达上限，请稍后再试。');
}

export async function sendEmailCode(req,env) {
  requireValue(env.RESEND_API_KEY && env.RESEND_FROM && env.VAULT_KEY,503,'邮件服务暂时不可用，请稍后再试。');
  const body = await readJson(req,2048);
  const email = typeof body.email==='string' ? body.email.trim().toLowerCase() : '';
  requireValue(email.length<=254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email),400,'请输入有效的邮箱地址。');
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  await reserve(env.DB,'ip:'+await signature(env,'ip:'+ip),3600,20);
  const id = newToken(), code = newCode();
  const mailbox=await signature(env,'mail:'+email);
  const cooling=await env.DB.prepare(`INSERT INTO email_send_limits VALUES(?,unixepoch()+60,1)
    ON CONFLICT(bucket) DO UPDATE SET expires=excluded.expires WHERE expires<=unixepoch() RETURNING used`)
    .bind('cooldown:'+mailbox).first();
  requireValue(cooling,429,'请在上一封邮件发出 60 秒后重试。');
  await reserve(env.DB,'mail:'+mailbox,3600,6);
  await reserve(env.DB,'outbox',86400,Number(env.EMAIL_DAILY_LIMIT)||100);
  const response = await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{
    Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':id
  },body:JSON.stringify({from:env.RESEND_FROM,to:[email],subject:'晚安邮局 · 登录验证码',
    text:'你的验证码是 '+code+'，10 分钟内有效。请勿转发。如果不是你发起的登录，可以忽略这封邮件。'})}).catch(()=>null);
  requireValue(response?.ok,503,'验证码邮件暂时未能发出，请稍后再试。');
  // The previous code stays usable until Resend accepts its replacement.
  await env.DB.prepare(`INSERT INTO email_challenges(email,id,digest,sent) VALUES(?,?,?,unixepoch())
    ON CONFLICT(email) DO UPDATE SET id=excluded.id,digest=excluded.digest,sent=excluded.sent,attempts=0`)
    .bind(email,id,await signature(env,id+':'+code)).run();
  return json({id});
}

async function verifiedMailbox(env,body) {
  const {id,code}=body;
  requireValue(typeof id==='string' && /^[0-9a-f]{64}$/.test(id) && typeof code==='string' && /^\d{6}$/.test(code),400,invalidCode);
  const digest=await signature(env,id+':'+code);
  // Serialize guesses and consumption in D1, including simultaneous submissions.
  const [,consumed]=await env.DB.batch([
    env.DB.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=? AND digest<>? AND attempts<5').bind(id,digest),
    env.DB.prepare('UPDATE email_challenges SET attempts=5 WHERE id=? AND digest=? AND attempts<5 AND sent>unixepoch()-? RETURNING email').bind(id,digest,lifetime)
  ]);
  const email=consumed.results?.[0]?.email;
  requireValue(email,401,invalidCode);
  return email;
}

async function attachExisting(env,email,claim,session) {
  requireValue(typeof claim==='string' && /^(story|invite)-[a-f0-9]{64}$/.test(claim),400,'旧凭据或邀请链接格式不正确。');
  const digest=await hash(claim), replacement=newToken();
  const [owner,member]=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO email_accounts SELECT ?,id,'owner' FROM families
      WHERE pass_hash=? AND (? IS NULL OR id=?)`).bind(email,digest,session?.family||null,session?.family||null),
    env.DB.prepare(`INSERT OR IGNORE INTO email_accounts SELECT ?,a.family,a.id FROM adult_accounts a
      JOIN families f ON f.id=a.family WHERE a.pass_hash=? AND (? IS NULL OR a.family=?)
      AND (a.pending=0 OR (a.expires>unixepoch() AND f.profile_count+
        (SELECT count(*) FROM adult_accounts WHERE family=a.family AND pending=0)<20))`).bind(email,digest,session?.family||null,session?.family||null),
    env.DB.prepare(`DELETE FROM sessions WHERE (family,adult) IN (
      SELECT e.family,e.adult FROM email_accounts e JOIN families f ON f.id=e.family
      WHERE e.email=? AND e.adult='owner' AND f.pass_hash=?
      UNION ALL SELECT e.family,e.adult FROM email_accounts e JOIN adult_accounts a ON a.family=e.family AND a.id=e.adult
      WHERE e.email=? AND a.pass_hash=?)`).bind(email,digest,email,digest),
    env.DB.prepare(`UPDATE families SET pass_hash=?,personal_login=1 WHERE pass_hash=? AND EXISTS
      (SELECT 1 FROM email_accounts WHERE family=families.id AND adult='owner' AND email=?)`).bind(replacement,digest,email),
    env.DB.prepare(`UPDATE adult_accounts SET pass_hash=?,pending=0 WHERE pass_hash=? AND EXISTS
      (SELECT 1 FROM email_accounts WHERE family=adult_accounts.family AND adult=adult_accounts.id AND email=?)`).bind(replacement,digest,email)
  ]);
  requireValue(owner.meta.changes || member.meta.changes,409,'无法绑定。请确认邮箱尚未加入其他家庭、旧凭据或邀请仍有效，且家庭未满。');
}

export async function verifyEmailCode(req,env,session) {
  const body=await readJson(req,2048);
  const email=await verifiedMailbox(env,body);
  if(body.claim)await attachExisting(env,email,body.claim,session);
  const lookup=()=>env.DB.prepare('SELECT family,adult FROM email_accounts WHERE email=?').bind(email).first();
  let account=await lookup();
  if(session)requireValue(account?.family===session.family,403,'请使用本家庭家长的邮箱。旧家庭请先绑定邮箱。');
  if(!account){
    const family=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO families(id,pass_hash,personal_login,profile_count)
        SELECT ?,?,1,2 WHERE NOT EXISTS(SELECT 1 FROM email_accounts WHERE email=?)`).bind(family,newToken(),email),
      env.DB.prepare("INSERT INTO email_accounts SELECT ?,id,'owner' FROM families WHERE id=?").bind(email,family)
    ]);
    account=await lookup();
  }
  return account;
}
