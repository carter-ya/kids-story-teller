// The static preview keeps its own local household. Worker sessions always start from the server.
let cloud=false,cloudRevision=0,cloudFamily=null,cloudDirty=false,cloudFlight=null,cloudTimer,cloudConflict=false,cloudMedia=0;
let cloudEpoch=0,cloudAdult=null,cloudAccounts=[],cloudServices=[];
let turnstileSiteKey;
let shelfWrites=Promise.resolve();
function serializeShelfWrite(action){
  const write=shelfWrites.then(action);shelfWrites=write.catch(()=>{});return write;
}
const childChanges=new Map(),polling=new Set();
async function api(path,method='GET',body){
  const response=await fetch('/api/'+path,{method,cache:'no-store',credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cloudFamily?{'X-Story-Family':cloudFamily}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok){const e=new Error(data.error||'云端暂时不可用。');e.status=response.status;throw e;}
  return data;
}
async function cloudBoot(){
  const r=await fetch('/api/session',{cache:'no-store'});
  if(r.status===404||(r.ok&&r.headers.get('content-type')?.includes('text/html')))return false;
  if(!r.ok)throw Error('家庭书架暂时不可用，请刷新重试。');
  const session=await r.json();if(session.cloud!==true)throw Error('无法识别家庭服务。');
  turnstileSiteKey=session.turnstileSiteKey;
  cloud=true;selectLoadingPage({member:Boolean(session.family),known:true,kid:session.kid});
  try{await enterCloud(session);}catch(e){
    if(![401,403].includes(e.status))throw e;
    await api('session/logout','POST',{});await enterCloud({});
  }
  return true;
}
async function enterCloud(session){
  clearTimeout(cloudTimer);cloudEpoch++;cloudAdult=null;cloudAccounts=[];cloudServices=[];cloudDirty=false;cloudConflict=false;childChanges.clear();
  state=firstState();signedIn=false;adult=false;cloudFamily=null;cloudMedia=0;cloudRevision=0;
  if(!session.family)return;
  cloudFamily=session.family;const row=await api('library');
  cloudRevision=row.revision;cloudMedia=row.mediaBytes;signedIn=true;adult=session.kid===null;
  cloudAdult=session.adult||null;cloudAccounts=row.accounts||[];
  state=row.state||firstState();
  if(adult)await refreshServices();
  if(!row.state){state.tourV2={step:1};markCloud();await flushCloud();}
}
function markCloud(){
  if(!signedIn||cloudConflict)return;
  cloudDirty=true;clearTimeout(cloudTimer);
  cloudTimer=setTimeout(()=>flushCloud().catch(e=>notify(e.message)),300);
}
async function flushCloud(){
  clearTimeout(cloudTimer);
  if(cloudFlight)return cloudFlight;
  if(cloudConflict)throw Error('云端版本已变化。请先导出当前稿件，再刷新页面。');
  if(!cloudDirty||!signedIn)return;
  cloudFlight=(async()=>{
    while(cloudDirty){
      cloudDirty=false;
      if(adult){await serializeShelfWrite(async()=>{const row=await api('library','PUT',{revision:cloudRevision,state});cloudRevision=row.revision;});}
      else for(const [id,patch] of childChanges){
        await api('library','PATCH',{id,...patch});if(childChanges.get(id)===patch)childChanges.delete(id);
      }
    }
  })();
  try{await cloudFlight;if($('#save-state'))$('#save-state').textContent='草稿已同步';}catch(e){cloudDirty=true;if(e.status===409&&adult)cloudConflict=true;throw e;}finally{cloudFlight=null;}
}
function listenerChange(id,patch){
  if(cloud&&signedIn&&!adult){childChanges.set(id,{...childChanges.get(id),...patch});markCloud();}
}
window.addEventListener('beforeunload',event=>{if(cloud&&(cloudDirty||cloudFlight)){event.preventDefault();event.returnValue='';}});
function cloudLogin(after,unlock=false,invitation=''){
  let email='',id='',readyAt=0;
  const mailProtection='<div data-mail-proof></div><small>此处使用 Cloudflare Turnstile 保护邮箱。<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">隐私说明</a></small>';
  async function sendCode(){
    const host=$('#dialog [data-mail-proof]');
    try{
      $('#dialog-error').textContent='';
      const token=await mailProof(host,turnstileSiteKey);
      if(!host.isConnected||!$('#dialog').open)return;
      return await api('session/email/send','POST',{email,turnstileToken:token});
    }catch(error){
      if(host.isConnected&&$('#dialog').open)throw error;
    }
  }
  function addressStep(){
    const heading=invitation?'加入家庭书架':unlock?'回到家长区':'邮箱登录';
    const hint=invitation?'用自己的邮箱接受邀请，以后用这个邮箱回到家庭。':unlock?'请用本家庭家长的邮箱接收验证码。':'首次验证会为你创建家庭书架。';
    dialog(heading,'<div class="mail-note"><span aria-hidden="true">'+icon('envelope',32)+'</span><p>'+hint+'</p></div>'+'<label class="field">家长邮箱<input type="email" name="email" autocomplete="email" inputmode="email" maxlength="254" required value="'+html(email)+'"></label>'+mailProtection,
      submitBtn('发送验证码'),async(data,form)=>{
        const button=form.querySelector('[type=submit]');
        if(button.disabled)return;
        email=data.get('email').trim();
        button.disabled=true;
        try{
          const response=await sendCode();
          if(!response||!button.isConnected||!$('#dialog').open)return;
          id=response.id;readyAt=Date.now()+60000;codeStep();
        }finally{button.disabled=false;}
      });

  }
  function codeStep(){
    dialog('查收验证码','<div class="mail-note"><span aria-hidden="true">'+icon('mail',32)+'</span><p>已寄到 <strong>'+html(email)+'</strong>，10 分钟内有效。</p></div>'+
      '<label class="field">六位验证码<input class="mail-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>'+mailProtection,
      '<button type="button" class="light" data-address>更改邮箱</button><button type="button" class="secondary" data-resend>重新发送</button>'+submitBtn('验证并继续'),async(data,form)=>{
        const button=form.querySelector('[type=submit]');
        if(button.disabled)return;
        button.disabled=true;
        try{
          await flushCloud();
          const session=await api('session/email/verify','POST',{id,code:data.get('code').trim(),claim:invitation});
          stopPlayback();await enterCloud(session);accepted();resumeJobs();
          if(after)after();else resumeTour();
        }finally{button.disabled=false;}
      });
    const resend=$('#dialog [data-resend]');
    const address=$('#dialog [data-address]');
    address.onclick=addressStep;
    function tick(){
      if(!resend.isConnected||!$('#dialog').open)return;
      const left=Math.ceil((readyAt-Date.now())/1000);
      resend.disabled=left>0;
      resend.textContent=left>0?'重新发送（'+left+' 秒）':'重新发送';
      if(left>0)setTimeout(tick,1000);
    }
    resend.onclick=async()=>{
      resend.disabled=true;
      try{
        const r=await sendCode();
        if(!r||!resend.isConnected||!$('#dialog').open)return;
        id=r.id;readyAt=Date.now()+60000;codeStep();
      }catch(e){if(resend.isConnected){$('#dialog-error').textContent=e.message;resend.disabled=false;}}
    };
    tick();$('#dialog [name=code]').focus();
  }
  addressStep();
}
function openEmailInvitation(){
  const match=location.hash.match(/^#join\/(invite-[a-f0-9]{64})$/);
  if(!cloud||!match)return false;
  history.replaceState(null,'',location.pathname+location.search+(signedIn?'#shelf':'#welcome'));
  cloudLogin(undefined,false,match[1]);return true;
}
async function changeCloudRole(kid){
  stopPlayback();await flushCloud();const s=await api('session/child','POST',{kid});
  await enterCloud(s);accepted();go('shelf');
}
async function cloudLogout(){
  stopPlayback();await flushCloud();await api('session/logout','POST',{});await enterCloud({});accepted();go('welcome');
}
const providerName=p=>p==='deepseek'?'DeepSeek':'OpenAI';
const defaultModel=p=>p==='deepseek'?'deepseek-flash':'gpt-4.1-mini';
async function refreshServices(){
  cloudServices=(await api('configs')).map(c=>({...c,name:providerName(c.provider)+' · '+typeName(c.type),managed:true,preferred:state.configDefaults?.[cloudAdult+':'+c.type]===c.id}));
}
async function refreshAccounts(){cloudAccounts=(await api('library')).accounts;}
on('invite-adult',()=>dialog('邀请成人',input('name','照护者昵称','',24)+'<p>对方可通过链接用自己的邮箱加入。链接一天内有效。</p>',submitBtn('生成邀请链接'),async d=>{
  await flushCloud();const r=await api('accounts','POST',{name:d.get('name')});
  await refreshAccounts();
  const url=new URL(location.pathname,location.origin);url.hash='join/'+r.code;
  dialog('分享给受邀家长','<p>将此链接私下发给对方，仅可使用一次。</p><textarea readonly aria-label="家庭邀请链接">'+html(url.href)+'</textarea>',submitBtn('完成'),()=>{accepted();render();},render);
}));
on('revoke-adult',id=>confirmAction('撤销这位成人的访问？','该成人将退出家庭，个人服务配置也会被清除。','撤销',async()=>{
  await api('accounts/'+id,'DELETE');await refreshAccounts();await refreshServices();render();
}));
function cloudConfig(type,c,after){
  const owned=cloudServices.filter(service=>service.owner===cloudAdult);
  function suggestedSource(services){
    return services.find(s=>s.id===c?.id)||services.find(s=>s.type!==type&&s.preferred)||services.find(s=>s.type!==type)||services[0];
  }
  const initial=c||suggestedSource(owned);
  const p=initial?.provider||'openai';
  const defaultEndpoint=provider=>'https://api.'+provider+'.com/v1';
  const body=pick('vendor','服务商',[['openai','OpenAI','moon'],['deepseek','DeepSeek','sun']],p)+
    (type==='write'?input('model','写作模型',c?.model||defaultModel(p)):'<p>已配好两种声音，可先试听一句。</p>')+
    '<div id="key-source"></div>'+fieldSecret('key','API Key')+'<details><summary>地址与用量</summary>'+input('endpoint','兼容 API 根地址',initial?.endpoint||defaultEndpoint(p),400)+
    input('daily','每天最多生成次数（0 表示不限）',c?.perDay||0)+input('monthly','每月最多输入字数',c?.perMonth||0)+input('perStory','每次最多输入字数',c?.perStory||0)+'</details>'+
    '<label><input type="checkbox" name="shared" '+(c?.share?'checked':'')+'> 授权家庭其他成人使用</label><p class="hint">写作会发送想法、年龄段和避讳，配音发送正文。生成消耗所选服务的额度。</p>';
  dialog('连接'+typeName(type)+'服务',body,submitBtn(after?'保存并继续':'保存配置'),async d=>{
    const id=c?.managed?c.id:uid(),provider=d.get('vendor');
    const keyFrom=d.get('keyFrom');
    const credential=keyFrom?(keyFrom===id?{}:{keyFrom}):{key:d.get('key').trim()};
    await api('configs/'+id,'PUT',{provider,type,model:d.get('model')||'',endpoint:d.get('endpoint').trim(),...credential,share:d.has('shared'),perDay:d.get('daily'),perMonth:d.get('monthly'),perStory:d.get('perStory')});
    if(c&&!c.managed)state.configs=state.configs.filter(x=>x.id!==c.id);
    (state.configDefaults||={})[cloudAdult+':'+type]=id;await refreshServices();save();await flushCloud();accepted();if(after)after();else render();
  });
  const form=$('#dialog-form'),sourcePicker=$('#key-source');
  const {vendor,endpoint,key,model}=form.elements;
  function selectSource(id){
    const source=owned.find(s=>s.id===id);
    key.disabled=!!source;
    key.required=!source;
    key.closest('.field').hidden=!!source;
    if(source){key.value='';endpoint.value=source.endpoint;}
  }
  function showSources(selected){
    const services=owned.filter(s=>s.provider===vendor.value);
    const choices=services.map(s=>[s.id,s.id===c?.id?'保留当前密钥':'复用'+typeName(s.type)+'密钥 · '+(s.model?s.model+' · ':'')+s.endpoint,s.type==='write'?'pen':'music']);
    choices.push(['','输入新的 API Key','pen']);
    sourcePicker.innerHTML=services.length?pick('keyFrom','API Key 来源',choices,selected):'';
    selectSource(selected);
  }
  showSources(initial?.managed?initial.id:'');
  sourcePicker.onchange=e=>selectSource(e.target.value);
  vendor.onchange=()=>{
    if(model)model.value=defaultModel(vendor.value);
    key.value='';endpoint.value=defaultEndpoint(vendor.value);
    showSources(suggestedSource(owned.filter(s=>s.provider===vendor.value))?.id||'');
  };
  endpoint.oninput=()=>{if(form.elements.keyFrom?.value)showSources('');};
}
on('check-service',async(id,b)=>{
  b.disabled=true;b.innerHTML=icon('paw')+' 正在连接';
  try{notify((await api('configs/'+id+'/check','POST',{})).message);}
  finally{b.disabled=false;b.textContent='检查连接';}
});
on('service-default',async id=>{const c=cloudServices.find(c=>c.id===id);(state.configDefaults||={})[cloudAdult+':'+c.type]=id;await refreshServices();save();render();});
on('service-edit',id=>{const c=cloudServices.find(c=>c.id===id);cloudConfig(c.type,c);});
on('service-delete',id=>confirmAction('删除个人配置？','此配置的密钥和家庭授权将被移除。','删除',async()=>{await api('configs/'+id,'DELETE');await refreshServices();render();}));
on('forget-key',p=>confirmAction('移除服务商密钥？','家庭成员需要重新连接才能用这项服务生成内容。','移除密钥',async()=>{await api('credentials/'+p,'DELETE');notify('密钥已移除。');}));
function cloudBegin(s,type,style){
  const c=configsFor(type).find(c=>c.preferred)||configsFor(type)[0];
  const input=(type==='write'?s.idea:s.text).trim();
  if(input.length>(type==='voice'?4000:2000)){notify(type==='voice'?'请将本篇拆成 4000 字以内的章节。':'请将故事想法缩短至 2000 字以内。');return;}
  const request=uid()+uid();
  state.jobs[s.id]={request,actor:cloudAdult,type,voice:style||'',input,title:s.title,provider:c.provider,model:c.model,config:c.id,managed:c.managed||false,listener:state.kid};
  markCloud();go('edit',s.id);cloudPoll(s.id);
}
function cloudPoll(id){
  const job=state.jobs[id],epoch=cloudEpoch;
  if(!adult||!job)return;
  const pollKey=epoch+':'+job.request;
  if(polling.has(pollKey))return;
  polling.add(pollKey);
  (async()=>{
    try{
      await flushCloud();
      if(epoch!==cloudEpoch)return;
      const data={id:job.request,kind:job.type,provider:job.provider,style:job.voice,input:job.input,model:job.model,config:job.managed?job.config:'',listener:job.listener||''};
      let result=job.actor&&job.actor!==cloudAdult?await api('generation/'+job.request):job.attempt?await api('generation/'+job.request+'/retry','POST',{attempt:job.attempt}):await api('generation','POST',data);
      while(['queued','running'].includes(result.status)){
        if(result.chapters && state.jobs[id]===job){
          job.chapters=result.chapters;job.completed=result.completed;
          if(page==='edit' && routeId===id && $('#job-progress'))$('#job-progress').textContent='已完成 '+result.completed+' / '+result.chapters+' 章';
        }
        await new Promise(r=>setTimeout(r,2000));
        if(epoch!==cloudEpoch)return;
        result=await api('generation/'+job.request);
      }
      if(epoch!==cloudEpoch||!story(id)||state.jobs[id]?.request!==job.request)return;
      const s=story(id);
      cloudMedia=result.mediaBytes;
      if(result.status==='done'){
        if(job.type==='voice')delete s.failedVoice;
        if(job.type==='write'){
          s.text=result.text;
          if(result.title)s.title=result.title;
          delete s.failedWrite;
        }
        else{s.recordings.unshift({id:result.id,cloud:true,title:job.title,text:job.input,voice:job.voice,provider:job.provider,bytes:result.bytes,duration:result.duration});advanceTour(3,4,id);}
        state.usage.push({at:Date.now(),type:job.type,config:job.config,chars:job.input.length});
      }else{if(result.retryable)s[job.type==='voice'?'failedVoice':'failedWrite']={...job,completed:result.completed};notify(result.error||'任务未完成，稿件已保留。');}
      delete state.jobs[id];s.updated=Date.now();save();if(page==='edit'||page==='create')render();
    }catch(e){
      if(epoch!==cloudEpoch)return;
      const missingRemote=e.status===404&&job.actor&&job.actor!==cloudAdult;
      if(!cloudConflict&&(missingRemote||[400,403,409,413,422,429].includes(e.status))){
        delete state.jobs[id];save();if(page==='edit')render();
        if([403,409,422].includes(e.status))await refreshServices().catch(()=>{});
      }
      else if(!cloudConflict)setTimeout(()=>{if(epoch===cloudEpoch)cloudPoll(id);},8000);
      notify(missingRemote?'另一位家长的任务尚未提交，稿件已保留。可选择自己的服务重新生成。':e.message);
    }finally{polling.delete(pollKey);}
  })();
}
async function cloudPreview(s,style){
  const c=configsFor('voice').find(c=>c.preferred)||configsFor('voice')[0];
  const text=(s.text.match(/^.{1,64}?[。！？]/u)?.[0]||[...s.text].slice(0,48).join('')).trim();if(!text){notify('先写一句故事。');return;}
  const result=await dialogJob('正在准备试听',{kind:'voice',provider:c.provider,config:c.managed?c.id:'',model:'',style,input:text});
  if(result)playTake({id:result.id,title:'试听一句',text,voice:style,duration:result.duration},s.cover);
}
async function dialogJob(label,data){
  const id=uid()+uid(),epoch=cloudEpoch;
  dialog(label,'<div class="wait"><span class="bob">'+icon('fox',34)+'</span><p>请稍候…</p></div>',act('dismiss','关闭'),null);
  const panel=$('#dialog-body').firstElementChild;
  try{
    let r=await api('generation','POST',{id,...data});
    while(['queued','running'].includes(r.status)){
      await new Promise(resolve=>setTimeout(resolve,1500));
      if(!panel.isConnected||epoch!==cloudEpoch)return;
      r=await api('generation/'+id);
    }
    if(!panel.isConnected||epoch!==cloudEpoch)return;
    cloudMedia=r.mediaBytes;
    if(r.status!=='done')throw Error(r.error||'生成失败。');
    return r;
  }catch(e){if(panel.isConnected)$('#dialog-error').textContent=e.message;}
}
function playTake(r,art){
  loadItem({id:r.id,recording:r.id,cover:cover(art),text:r.text,title:r.title,voice:r.voice,duration:r.duration,audio:'/api/audio/'+encodeURIComponent(r.id)},true);
  dialog('试听朗读','<p>'+html(r.title)+' · '+html(r.voice)+' · AI 合成</p>',act('toggle','播放 / 暂停')+submitBtn('结束试听'),()=>{stopPlayback();accepted()},stopPlayback);play();
}

function retryDraft(failed){
  const s=story(routeId);
  if(!failed||failed.actor!==cloudAdult)return;
  const action=failed.type==='write'?'写作':'配音';
  confirmAction('继续上次的'+action+'？','已完成的部分会复用，服务商将对后续生成计费。','继续'+action,()=>{
    state.jobs[s.id]={...failed,attempt:uid()+uid()};save();render();cloudPoll(s.id);
  });
}
on('retry-voice',()=>retryDraft(story(routeId)?.failedVoice));
on('retry-write',()=>retryDraft(story(routeId)?.failedWrite));
on('archive-family',async()=>{
  await flushCloud();
  const link=document.createElement('a');link.href='/api/family/archive';link.download='family-stories.tar';link.click();
});
on('erase-family',()=>dialog('永久删除整个家庭','<p>故事、录音、封面、成员和密钥都将删除。需要保留的内容请先导出。</p>'+input('confirm','请输入「删除整个家庭」'),submitBtn('永久删除'),async d=>{
  const confirm=d.get('confirm');if(confirm!=='删除整个家庭')throw Error('确认文字不匹配。');
  stopPlayback();await flushCloud();await api('family','DELETE',{confirm});
  await enterCloud({});accepted();go('welcome');
}));
document.addEventListener('change',async event=>{
  const field=event.target;if(field.id!=='cover-upload')return;
  const file=field.files?.[0],s=story(routeId),epoch=cloudEpoch;if(!file||!s)return;
  field.disabled=true;
  try{
    if(file.size>12000000)throw Error('请选择小于 12 MB 的图片。');
    const bitmap=await createImageBitmap(file);
    const scale=Math.min(1,900/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.82));
    if(!blob||blob.type!=='image/webp')throw Error('此浏览器无法保存 WebP 封面。');
    if(epoch!==cloudEpoch)return;
    const r=await fetch('/api/covers',{method:'POST',headers:{'Content-Type':'image/webp','X-Story-Family':cloudFamily},body:blob});
    const data=await r.json();if(!r.ok)throw Error(data.error);
    if(epoch!==cloudEpoch||story(s.id)!==s)return;
    s.cover=data.cover;cloudMedia+=data.bytes;markCloud();await flushCloud();render();notify('封面已保存。');
  }catch(e){notify(e.message);}finally{field.disabled=false;}
});
