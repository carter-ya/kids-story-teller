// The static preview keeps its own local household. Worker sessions always start from the server.
let cloud=false,cloudRevision=0,cloudFamily=null,cloudDirty=false,cloudFlight=null,cloudTimer,cloudConflict=false,cloudMedia=0;
let cloudEpoch=0;
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
  clearTimeout(cloudTimer);cloudEpoch++;cloudDirty=false;cloudConflict=false;childChanges.clear();
  state=firstState();signedIn=false;adult=false;cloudFamily=null;cloudMedia=0;cloudRevision=0;
  if(!session.family)return;
  cloudFamily=session.family;const row=await api('library');
  cloudRevision=row.revision;cloudMedia=row.mediaBytes;signedIn=true;adult=session.kid===null;
  state=row.state||firstState();
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
      if(adult){const row=await api('library','PUT',{revision:cloudRevision,state});cloudRevision=row.revision;}
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
  dialog(unlock?'回到家长区':'登录家庭书架',fieldSecret('pass','家庭登录码')+'<p class="hint">在另一台设备输入同一个登录码，就能继续使用家庭书架。</p>',(!unlock?act('cloud-new','创建新家庭','secondary'):'')+submitBtn('打开书架'),async d=>{
    stopPlayback();await flushCloud();const session=await api('session/login','POST',{pass:d.get('pass').trim()});
    await enterCloud(session);accepted();resumeJobs();if(after)after();else resumeTour();
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
function cloudConfig(type,c,after){
  const provider=c?.provider||'openai';
  const fields=pick('vendor','服务商',[['openai','OpenAI','moon'],['deepseek','DeepSeek','sun']],provider)+
    (type==='write'?input('model','写作模型',c?.model||defaultModel(provider)):'<p class="hint">两种声音已配好。生成前可以试听一句。</p>')+
    fieldSecret('key','API Key')+'<p class="hint">同一家庭的写作和配音共用服务商密钥。已有密钥可留空。生成会使用服务商账户的额度。</p>';
  dialog('连接'+typeName(type)+'服务',fields,submitBtn(after?'保存并继续':'保存配置'),async d=>{
    const p=d.get('vendor'),key=d.get('key').trim(),model=type==='write'?d.get('model').trim():'';
    if(type==='write'&&!/^[\w.:-]{1,100}$/.test(model))throw Error('请输入模型名称。');
    if(key)await api('credentials/'+p,'PUT',{key});
    else if(!(await api('credentials/'+p)).configured)throw Error('第一次连接请填写服务商密钥。');
    const rec={id:c?.id||uid(),type,provider:p,model,name:providerName(p)+' · '+typeName(type),preferred:c?c.preferred:!configsFor(type).length,share:true};
    if(c)state.configs[state.configs.indexOf(c)]=rec;else state.configs.push(rec);
    save();await flushCloud();accepted();if(after)after();else render();
  });
}
document.addEventListener('change',e=>{if(e.target.name==='vendor'&&$('#dialog-body [name=model]'))$('#dialog-body [name=model]').value=defaultModel(e.target.value);});
on('forget-key',p=>confirmAction('移除服务商密钥？','家庭成员需要重新连接才能用这项服务生成内容。','移除密钥',async()=>{await api('credentials/'+p,'DELETE');notify('密钥已移除。');}));
function cloudBegin(s,type,style){
  const c=configsFor(type).find(c=>c.preferred)||configsFor(type)[0];
  const input=(type==='write'?s.idea:s.text).trim();
  if(input.length>(type==='voice'?4000:2000)){notify(type==='voice'?'请将本篇拆成 4000 字以内的章节。':'请将故事想法缩短至 2000 字以内。');return;}
  const request=uid()+uid();
  state.jobs[s.id]={request,type,voice:style||'',input,title:s.title,provider:c.provider,model:c.model,config:c.id};
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
      const data={id:job.request,kind:job.type,provider:job.provider,style:job.voice,input:job.input,model:job.model};
      let result=await api('generation','POST',data);
      while(['queued','running'].includes(result.status)){
        await new Promise(r=>setTimeout(r,2000));
        if(epoch!==cloudEpoch)return;
        result=await api('generation/'+job.request);
      }
      if(epoch!==cloudEpoch||!story(id)||state.jobs[id]?.request!==job.request)return;
      const s=story(id);
      if(result.status==='done'){
        cloudMedia=result.mediaBytes;
        if(job.type==='write')s.text=result.text;
        else{s.recordings.unshift({id:result.id,cloud:true,title:job.title,text:job.input,voice:job.voice,provider:job.provider,bytes:result.bytes,duration:result.duration});advanceTour(3,4,id);}
        state.usage.push({at:Date.now(),type:job.type,config:job.config,chars:job.input.length});
      }else notify(result.error||'任务未完成，稿件已保留。');
      delete state.jobs[id];s.updated=Date.now();save();if(page==='edit'||page==='create')render();
    }catch(e){
      if(epoch!==cloudEpoch)return;
      if([400,413,422].includes(e.status)){delete state.jobs[id];save();if(page==='edit')render();}
      else if(!cloudConflict)setTimeout(()=>{if(epoch===cloudEpoch)cloudPoll(id);},8000);
      notify(e.message);
    }finally{polling.delete(pollKey);}
  })();
}
async function cloudPreview(s,style){
  const c=configsFor('voice').find(c=>c.preferred)||configsFor('voice')[0];
  const text=(s.text.match(/^.{1,64}?[。！？]/u)?.[0]||[...s.text].slice(0,48).join('')).trim();if(!text){notify('先写一句故事。');return;}
  const result=await dialogJob('正在准备试听',{kind:'voice',provider:c.provider,model:'',style,input:text});
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
    if(r.status!=='done')throw Error(r.error||'生成失败。');
    return r;
  }catch(e){if(panel.isConnected)$('#dialog-error').textContent=e.message;}
}
function playTake(r,art){
  loadItem({id:r.id,recording:r.id,cover:cover(art),text:r.text,title:r.title,voice:r.voice,duration:r.duration,audio:'/api/audio/'+encodeURIComponent(r.id)},true);
  dialog('试听朗读','<p>'+html(r.title)+' · '+html(r.voice)+' · AI 合成</p>',act('toggle','播放 / 暂停')+submitBtn('结束试听'),()=>{stopPlayback();accepted()},stopPlayback);play();
}
