// The static preview keeps its own local household. Worker sessions always start from the server.
let cloud=false,cloudRevision=0,cloudFamily=null,cloudDirty=false,cloudFlight=null,cloudTimer,cloudConflict=false,cloudMedia=0;
let cloudEpoch=0,cloudAdult=null,cloudAccounts=[],cloudServices=[];
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
  cloud=true;
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
function cloudLogin(after,unlock=false){
  dialog(unlock?'回到家长区':'登录家庭书架',fieldSecret('pass','家庭登录码')+'<p class="hint">使用自己的登录码，或输入家长发给你的一次性邀请码。</p>',(!unlock?act('cloud-new','创建新家庭','secondary'):'')+submitBtn('打开书架'),async d=>{
    stopPlayback();await flushCloud();const session=await api('session/login','POST',{pass:d.get('pass').trim()});
    await enterCloud(session);accepted();resumeJobs();
    const next=()=>after?after():resumeTour();
    if(session.pass)showCode('你的个人登录码',session.pass,next);else next();
  });
}
on('cloud-new',async(_,b)=>{
  b.disabled=true;
  try{const s=await api('session/create','POST',{});await enterCloud(s);
    dialog('请保存家庭登录码','<p>保存在密码管理器中。持有码的人可管理这个家庭和调用已连接的服务。</p><textarea readonly aria-label="家庭登录码">'+html(s.pass)+'</textarea>',submitBtn('已保存，开始引导'),()=>{accepted();resumeTour()},resumeTour);
  }catch(e){$('#dialog-error').textContent=e.message;b.disabled=false;}
});
async function changeCloudRole(kid){
  stopPlayback();await flushCloud();const s=await api('session/child','POST',{kid});
  await enterCloud(s);accepted();go('shelf');
}
async function cloudLogout(){
  stopPlayback();await flushCloud();await api('session/logout','POST',{});await enterCloud({});accepted();go('welcome');
}
const providerName=p=>p==='deepseek'?'DeepSeek':'OpenAI';
const defaultModel=p=>p==='deepseek'?'deepseek-flash':'gpt-4.1-mini';
function showCode(title,code,next=render){
  dialog(title,'<p>请保存在密码管理器中。</p><textarea readonly aria-label="登录码">'+html(code)+'</textarea>',submitBtn('已保存'),()=>{accepted();next()},next);
}
async function refreshServices(){
  cloudServices=(await api('configs')).map(c=>({...c,name:providerName(c.provider)+' · '+typeName(c.type),managed:true,preferred:state.configDefaults?.[cloudAdult+':'+c.type]===c.id}));
}
async function refreshAccounts(){cloudAccounts=(await api('library')).accounts;}
on('invite-adult',()=>dialog('邀请成人',input('name','照护者昵称','',24)+'<p>邀请码一天内有效，仅可使用一次。请私下交给对方。</p>',submitBtn('生成邀请码'),async d=>{
  await flushCloud();const r=await api('accounts','POST',{name:d.get('name')});
  await refreshAccounts();showCode('请私下分享一次性邀请码',r.code);
}));
on('revoke-adult',id=>confirmAction('撤销这位成人的访问？','该成人的登录码、已登录设备和个人服务配置会失效。','撤销',async()=>{
  await api('accounts/'+id,'DELETE');await refreshAccounts();await refreshServices();render();
}));
on('rotate-owner',()=>confirmAction('更换管理员登录码？','旧码和其他管理员设备将立即失效，请保存新码。','更换',async()=>{
  const r=await api('session/rotate','POST',{});showCode('新的管理员登录码',r.pass);
}));
function cloudConfig(type,c,after){
  const p=c?.provider||'openai';
  const body=pick('vendor','服务商',[['openai','OpenAI','moon'],['deepseek','DeepSeek','sun']],p)+
    (type==='write'?input('model','写作模型',c?.model||defaultModel(p)):'<p>已配好两种声音，可先试听一句。</p>')+
    fieldSecret('key','API Key')+'<details><summary>地址与用量</summary>'+input('endpoint','兼容 API 根地址',c?.endpoint||'https://api.'+p+'.com/v1',400)+
    input('daily','每天最多生成次数（0 表示不限）',c?.perDay||0)+input('monthly','每月最多输入字数',c?.perMonth||0)+input('perStory','每次最多输入字数',c?.perStory||0)+'</details>'+
    '<label><input type="checkbox" name="shared" '+(c?.share?'checked':'')+'> 授权家庭其他成人使用</label><p class="hint">写作会发送想法、年龄段和避讳，配音发送正文。生成消耗所选服务的额度。</p>';
  dialog('连接'+typeName(type)+'服务',body,submitBtn(after?'保存并继续':'保存配置'),async d=>{
    const id=c?.managed?c.id:uid(),provider=d.get('vendor');
    await api('configs/'+id,'PUT',{provider,type,model:d.get('model')||'',endpoint:d.get('endpoint').trim(),key:d.get('key').trim(),share:d.has('shared'),perDay:d.get('daily'),perMonth:d.get('monthly'),perStory:d.get('perStory')});
    if(c&&!c.managed)state.configs=state.configs.filter(x=>x.id!==c.id);
    (state.configDefaults||={})[cloudAdult+':'+type]=id;await refreshServices();save();await flushCloud();accepted();if(after)after();else render();
  });
}
document.addEventListener('change',e=>{if(e.target.name==='vendor'){
  const model=$('#dialog-body [name=model]');if(model)model.value=defaultModel(e.target.value);
  $('#dialog-body [name=endpoint]').value='https://api.'+e.target.value+'.com/v1';
}});
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
        await new Promise(r=>setTimeout(r,2000));
        if(epoch!==cloudEpoch)return;
        result=await api('generation/'+job.request);
      }
      if(epoch!==cloudEpoch||!story(id)||state.jobs[id]?.request!==job.request)return;
      const s=story(id);
      cloudMedia=result.mediaBytes;
      if(result.status==='done'){
        if(job.type==='voice')delete s.failedVoice;
        if(job.type==='write')s.text=result.text;
        else{s.recordings.unshift({id:result.id,cloud:true,title:job.title,text:job.input,voice:job.voice,provider:job.provider,bytes:result.bytes,duration:result.duration});advanceTour(3,4,id);}
        state.usage.push({at:Date.now(),type:job.type,config:job.config,chars:job.input.length});
      }else{if(job.type==='voice'&&result.retryable)s.failedVoice={...job,completed:result.completed};notify(result.error||'任务未完成，稿件已保留。');}
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

on('retry-voice',()=>{const s=story(routeId),failed=s?.failedVoice;
  if(!failed||failed.actor!==cloudAdult)return;
  confirmAction('继续上次的配音？','已完成的片段会复用。再次请求剩余片段可能产生服务商费用。','继续配音',()=>{
    state.jobs[s.id]={...failed,attempt:uid()+uid()};save();render();cloudPoll(s.id);
  });
});
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
