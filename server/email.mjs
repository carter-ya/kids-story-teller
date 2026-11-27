import {hash,json,newToken,readJson,requireValue} from './common.mjs';

const lifetime = 600;
const invalidCode = '验证码不正确或已失效，请检查邮件或重新获取。';

// Inline copy of web/assets/postmark.svg, rasterized at 2x for email readers.
const foxPostmark = 'iVBORw0KGgoAAAANSUhEUgAAAGwAAABoCAMAAAAjKeXpAAABIFBMVEUAAAAgMEDw4KDQYEDw8MDwwHDQwJAwQEAwMEAgMEDQcEDw0KDg0JDAsIAgMEAgMEAgMEBQQEAgMEDgkFBwcGAgMEAgMEBQYFCgUEAgMEAgMEBQUFDw4MBAQFCwoIBgYGBAUFAgMEAgMEBgQECAgGAgMEDAYECAgHBAMECQUEAgMEBwQECgkHCwUECQgHCQkHDAwKAgIECAUEBQYGAgIEDggFDgsGDgwJDAsJCwYEDgoGDgkGCAQEDAYDDgsHDgoHDw0LAgIEDQcFDwwKCgoIDg0KDQgFDw4LDgoICwsIBAQEDQYDAgIDAgMDAwQFAQMDBwcHBQUGCQkICAcGDw0JDggGDgkHDgsIDQwLCwoJDg0LDgsJDwwJCAYFDg4MCwsKDZSzumAAAAYHRSTlMA//////////+Z/////93uzP9V//+qd///u4j///////9EZv//M/////8i////////Iv//Ef///////////////zP/////////////IhH/Ef/////////////////////FyBPDAAAHeElEQVR42u1aWVsaSRS1u+1m36QREGSVHUEdjTGamKhJTDIxy2RfJv//X0zX2rU3iN88eR8E7Kp76t46depWwdravd3bvd29jf8/qC3L2tI/3d+/Q6h21grsUPe4ZFnV3l1hJSxo2uHDp4nDu4DayCEsSzub6HFuc2WodyXLigBbIw2yG6thdXIUK6ttlKdtVpm6cRX5KBSCP/k1A0Go3XrqNrGDgzcArGRaF5bVtVaZuh7OTqHvOEMwZj2FQLP+7vD2U7eFesZHTmDx4J1+xD3QsOI4oziGy/dusYyD5PQBlgPedtaMdISDOrvN1OFlHK9AKKcPPhiSA0Y2gS0fLz11ZBlP3iAsZxd8eqbvAEhbIG2XmrpDzPfhrkNsBD7/bZ7feNh68akjy/gM9SyCPwdGAQn6gOdOaJqp23/2jNPXMeH7CeyVfHAEXiZgEkx0Al12ydDkqRtvVvNUinL5amfMLWPU58h14WvXKCBB5gkdi0+S0tRtJrKWZNlEh1nGwB657iP4BghI1ZT7HKZj0nWL0tSZDC1jkELXddFAh0a1wnTsgpZPXPdBUpo6rXUf0xQGHdF7MMatqHU5hHwCvV444tRZ8UJ3cjaqVEZnk26B/hMvY5DCwI4cKiCbkZLtoDy6JPlk6obd0YnD2cmoOwyXMUyhi+kRKSCYjn2cx8AoTwK4vqO0Ps4gSmE4whPgqm3c+LAU4zy6DE+i7BHugOnhVIArc91I10uS9A15YjKSQkoPpFZm3ckTOuI8cjzR2xFtTOgRqVa4MkBSXKTdF8hk2Ngl/5oYyx1BipPuMrNG0SiBo9SKVgZsHhdkSJGnB1KrUkTBQumIuy/MxiJHj6hyR6gMUB4XxsJoR/RjPEpAuMoA5JFi9U/0KGS5Fxl6RJY7YmVQpFiVAh2BbAETCiTxob5FqxVfGSSLIRS/g3OGdjMkO4y6RZQ7ysog3GA02njC79OLljt8ZRDhLLQD5WAWEJC1tbchHeU0qS1M88XR6fn56dHFAuWOUBlcfP4S9HyRnJihCNzv1Mt1aqmvsxssIIe9KClOnj+lHeteI1L4TzPf1gV7D8uddtW4tIPK4MP3Ot+xfnlqQLq4fikirdd9oFZtVCe/M1UGzR9S5/WX15rwkj/rcuunSSAgpPTbN9Ix/l3hoH7NozyuAP6dylGtr//CtIo6xKNC1ao9VfhIXVCcA1DpWAfJX+vqUVVMYOND8fTYUAV3HkgDwkH2TYV16lSGXNUss6LaEdB+Xyo8XRa44lQ1XRcVvo20haL/ljaYHTRYXV9kX3XOzXvFaDioWE3eQvfpyaQEK70eOqoM+z9FXz9YrJt/JawpF1U53VJsoUyDXCLAe4eOJvHdzyJRPjJN/4hQe3wCB7YdU2yhwjloq0cuYCrOVyGXe9u6JO594A82r2zbVm2h0skru4XP/hPnhRBcfYDng0/i3l+8h9ZxgJVWbaF5xTEIDyDYts+Vwf1RQ71GL74NzFNtoSBpNV999hr2neSlHNxACVVrodcpxLIbqi0U5KxlP2ypT5W7sirVv6mgylcxlGEPYdlTlYCAdRwLHs7JkbbGwY00eitAZaa483OMZc9UWyisPMDTdBP33J432VRW3khEkaBsnzKemK+qwaFmpOHzDKG2f3xVZnLZrTjXdRPUMeoYz4RYdlN1YwCrbo+JHWZ+aqenTD7jk5NLLZSdiYeMp1ZTFfzwxNkgTY5JRLUAPz1naBP/7amh7AHLeGo3yhsDhq6QsjHsaCcFVstgO8Tb/vhDhnpe4xhPTX1jAJR3xrRK/UNyCeL9lPZ2YiHeh48MlBcMxxMYT72oa/CslAKPzFbZ8yHDMn5MXIFBVGB5z4nGC1hIQNrK80RTaDpl75Ggo1e+AIXGjmxmS5ZR3xhAvRLbpn0BLHDeaLJzhcZONV60hrrcARLyWm5NBawVpigFll+ZrCYyt1cKLHuuBtskEiLYgIY2Z0P25OeQt4reWc3B/ZPUmpWslic9fs5K6PZD6bmvvjFosxJCA0C+YoSFvkA3wvirbU1wZfWNAZSQjNJXMF2MgLFspRqf2lEH19LcGHB6FVIpWBBQQ4iAledk+zj2WcZnXquCi2luDEQOkGhmooBZ5Z1ppjH3BcbT4DKCWnU0VxIDmRphsMSbXNWQZSLNXFp3Y5Dn9CrdUoidVxOxeIGTgvN0NwZAQsoyNQTK+KyC7UhaKATX0N0YoJKHp4ZikaemZTiQmyZliq3YLFBwU93hjJQ8oSrMbJ0de5+0z1haznQ3BrTkkamxnDFrztddOZKSh6iGZ9/aSHDTpu4LElzyYGrU0vYKRoJr6e43UcljoMZShmgZ035BAkGiqLFUcAP9FyThV/SN20OkvUxjOtvxm7VtvCI3jN/1L0kN6H4+AO5jqlNJW3uFqlINhfuHr66A+3IrFv3F2lvDDwt8ZXaOcXbKNDuLWkJ/XxumMCo7Rstl89VSYmuzszE2fXW2cHZk/9h9u7fI74A2bjV86H75Hzy1l8hOb//tar+FOdT4XyY7y/7ogcnO3boX5XHl7Nzbva1i/wELV8ncG5i51QAAAABJRU5ErkJggg==';

export function verificationLetter(code) {
  const minutes=lifetime/60;
  const subject='晚安邮局 · 登录验证码';
  const text=`亲爱的家长，小狐狸把你的登录验证码送到了。

${code}

回到晚安邮局，输入这六位数字即可继续。验证码 ${minutes} 分钟内有效，请勿转发。
如果你没有请求验证码，忽略这封信即可。

小狐狸邮差
晚安邮局`;
  const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;background-color:#f5edda;color:#243348;font-family:'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">小狐狸送来了登录验证码，请在 ${minutes} 分钟内使用。</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f5edda"><tr><td align="center" style="padding:24px 10px">
    <!--[if mso]><table role="presentation" width="488" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#fffbf1" style="max-width:488px;border:1px solid #cbbf9f;border-top:5px solid #a74029;border-radius:4px">
      <tr><td style="padding:18px 22px 14px;border-bottom:3px double #b7a582">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td width="65"><img src="cid:fox-postmark" alt="" width="54" height="52" style="display:block;border:0"></td>
          <td style="font-family:'Songti SC','Noto Serif CJK SC',serif;font-weight:bold;font-size:22px;color:#243348">晚安邮局</td>
          <td align="right"><span style="display:inline-block;padding:4px 9px;border:2px solid #a74029;border-radius:50%;color:#a74029;font-size:12px;font-weight:bold;line-height:17px;text-align:center">月亮<br>夜班</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:24px 22px 16px">
        <h1 style="margin:0 0 8px;font: bold 24px/1.4 'Songti SC','Noto Serif CJK SC',serif;color:#243348">小狐狸来送信啦！</h1>
        <p style="margin:0;font-size:15px;line-height:24px">亲爱的家长，请回到晚安邮局，输入下面的六位数字。</p>
      </td></tr>
      <tr><td style="padding:0 22px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f8e7bb" style="border:1px dashed #ab884e;border-radius:6px"><tr><td align="center" style="padding:14px 4px">
          <p style="margin:0;color:#285749;font-size:14px;font-weight:bold">登录验证码</p>
          <p dir="ltr" style="margin:5px 0;font:bold 36px/1.3 'Courier New',monospace;letter-spacing:4px;color:#243348">${code}</p>
          <p style="margin:0;font-size:13px;color:#5b503e">${minutes} 分钟内有效，请勿转发</p>
        </td></tr></table>
      </td></tr>
      <tr><td align="right" style="padding:17px 22px;color:#285749;font: bold 16px/1.6 'Songti SC',serif">小狐狸邮差</td></tr>
      <tr><td style="padding:14px 22px;border-top:1px dashed #cbbf9f;color:#58594f;font-size:13px;line-height:21px">如果你没有请求验证码，忽略这封信即可。</td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr></table>
</body></html>`;
  return {subject,text,html,attachments:[{filename:'fox-postmark.png',content:foxPostmark,content_id:'fox-postmark'}]};
}

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

async function reserve(db,bucket,period,limit,message='发送次数已达上限，请稍后再试。') {
  const row = await db.prepare(`INSERT INTO email_send_limits VALUES(?,unixepoch()+?,1)
    ON CONFLICT(bucket) DO UPDATE SET used=CASE WHEN expires<=unixepoch() THEN 1 ELSE used+1 END,
    expires=CASE WHEN expires<=unixepoch() THEN excluded.expires ELSE expires END
    WHERE expires<=unixepoch() OR used<? RETURNING used`).bind(bucket,period,limit).first();
  requireValue(row,429,message);
}

async function checkTurnstile(req,env,token) {
  requireValue(typeof token==='string' && token.length>0 && token.length<=2048,400,'请重新进行安全验证。');
  const remoteip=req.headers.get('CF-Connecting-IP');
  const result=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
    method:'POST',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},
    body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token,...(remoteip?{remoteip}:{})})
  }).then(r=>r.ok?r.json():null).catch(()=>null);
  requireValue(result,503,'安全验证暂时不可用，请稍后重试。');
  requireValue(result.success===true && result.hostname===new URL(req.url).hostname && result.action==='email_send',
    403,'安全验证已失效，请重试。');
  // Siteverify replay detection can converge after redemption. Claim the proof atomically here, too.
  await reserve(env.DB,'proof:'+await hash(token),300,1,'安全验证已使用，请重试。');
}

export async function sendEmailCode(req,env) {
  requireValue(env.RESEND_API_KEY && env.RESEND_FROM && env.VAULT_KEY && env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY,503,'邮件服务暂时不可用，请稍后再试。');
  const body = await readJson(req,4096);
  const email = typeof body.email==='string' ? body.email.trim().toLowerCase() : '';
  requireValue(email.length<=254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email),400,'请输入有效的邮箱地址。');
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  await reserve(env.DB,'ip:'+await signature(env,'ip:'+ip),3600,20);
  await checkTurnstile(req,env,body.turnstileToken);
  const id = newToken(), code = newCode();
  const mailbox=await signature(env,'mail:'+email);
  const cooling=await env.DB.prepare(`INSERT INTO email_send_limits VALUES(?,unixepoch()+60,1)
    ON CONFLICT(bucket) DO UPDATE SET expires=excluded.expires WHERE expires<=unixepoch() RETURNING used`)
    .bind('cooldown:'+mailbox).first();
  requireValue(cooling,429,'请在上一封邮件发出 60 秒后重试。');
  await reserve(env.DB,'mail:'+mailbox,3600,6);
  await reserve(env.DB,'mail-day:'+mailbox,86400,12);
  await reserve(env.DB,'outbox',86400,Number(env.EMAIL_DAILY_LIMIT)||100);
  const response = await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{
    Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':id
  },body:JSON.stringify({from:env.RESEND_FROM,to:[email],...verificationLetter(code)})}).catch(()=>null);
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

async function acceptInvitation(env,email,claim,session) {
  requireValue(typeof claim==='string' && /^invite-[a-f0-9]{64}$/.test(claim),400,'邀请链接格式不正确。');
  const digest=await hash(claim);
  const [joined]=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO email_accounts SELECT ?,a.family,a.id FROM adult_accounts a
      JOIN families f ON f.id=a.family WHERE a.pass_hash=? AND a.pending=1 AND a.expires>unixepoch()
      AND (? IS NULL OR a.family=?) AND f.profile_count+
      (SELECT count(*) FROM adult_accounts WHERE family=a.family AND pending=0)<20`).bind(email,digest,session?.family||null,session?.family||null),
    env.DB.prepare(`UPDATE adult_accounts SET pass_hash=?,pending=0 WHERE pass_hash=? AND pending=1 AND EXISTS
      (SELECT 1 FROM email_accounts WHERE family=adult_accounts.family AND adult=adult_accounts.id AND email=?)`).bind(newToken(),digest,email)
  ]);
  requireValue(joined.meta.changes,409,'无法加入。请确认邀请仍有效、家庭未满，且邮箱尚未加入其他家庭。');
}

export async function verifyEmailCode(req,env,session) {
  const body=await readJson(req,2048);
  const ipKey=await signature(env,'ip:'+(req.headers.get('CF-Connecting-IP')||'local'));
  const slowDown='验证码尝试太频繁，请稍后再试。';
  await reserve(env.DB,'verify-minute:'+ipKey,60,12,slowDown);
  await reserve(env.DB,'verify-hour:'+ipKey,3600,60,slowDown);
  const email=await verifiedMailbox(env,body);
  if(body.claim)await acceptInvitation(env,email,body.claim,session);
  const lookup=()=>env.DB.prepare('SELECT family,adult FROM email_accounts WHERE email=?').bind(email).first();
  let account=await lookup();
  if(session)requireValue(account?.family===session.family,403,'请使用本家庭家长的邮箱。');
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
