// Load the official widget only when a parent asks us to send an email.
let loadingTurnstile;
function getTurnstile(){
  if(window.turnstile)return Promise.resolve(window.turnstile);
  if(loadingTurnstile)return loadingTurnstile;
  loadingTurnstile=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    function failed(){
      clearTimeout(timer);script.remove();loadingTurnstile=null;
      reject(Error('安全验证未加载，请检查网络后重试。'));
    }
    const timer=setTimeout(failed,15000);
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async=true;
    script.onload=()=>{if(!window.turnstile)return failed();clearTimeout(timer);resolve(window.turnstile)};
    script.onerror=failed;
    document.head.append(script);
  });
  return loadingTurnstile;
}

async function mailProof(host,sitekey){
  if(!sitekey)throw Error('邮箱安全验证尚未配置。');
  host.setAttribute('role','status');host.textContent='正在安全验证…';
  let api,widget,timer;
  try{
    api=await getTurnstile();
    if(!host.isConnected)return;
    const mount=document.createElement('div');
    host.append(mount);
    return await new Promise((resolve,reject)=>{
      const failed=()=>{reject(Error('安全验证未完成，请重试。'));return true;};
      timer=setTimeout(failed,30000);
      widget=api.render(mount,{sitekey,action:'email_send',appearance:'interaction-only',retry:'never',
        callback:resolve,'error-callback':failed,'expired-callback':failed,'timeout-callback':failed});
    });
  }finally{
    clearTimeout(timer);
    if(widget!==undefined)api.remove(widget);
    host.replaceChildren();
  }
}
