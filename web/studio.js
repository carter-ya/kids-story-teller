const voices=[['温柔晚安','温柔晚安','moon'],['轻快晨读','轻快晨读','sun']];
const covers=SAMPLES.map(s=>[s.id,s.theme,'flower']);
let importMode=false,libraryQuery='',libraryChild='all';
const jobTimers=new Map();
function makeStory(idea, text='',series=''){
  return {id:uid(),idea,title:idea.slice(0,36)||'我的新故事',text,series,cover:'fox',versions:[],recordings:[],published:null,archived:false,updated:Date.now()};
}
function buildText(s){
  const who=child()?.name||'小朋友';
  return `“${s.idea}。”${who}把这个念头写进信封，放在窗台上。\n\n天刚擦黑，小狐狸邮差就来了。它举起小灯，沿着蒲公英小路走，一步，两步。风吹响树叶，小狐狸停下脚步，听见一只迷路的小鸟在轻轻哼歌。\n\n“我们一起走吧。”它把灯提得高了一点。月光下，小鸟看见熟悉的屋顶，扇扇翅膀飞回了家。\n\n等小狐狸回到窗前，信封里多了一根小羽毛。它轻轻说：“晚安。明天，这里还有新的故事。”`;
}
function jobLabel(j){return j.type==='write'?'小狐狸正在写故事':'小狐狸正在准备朗读'}
function schedule(id){
  if(jobTimers.has(id))return;
  const job=state.jobs[id];if(!job)return;
  jobTimers.set(id,setTimeout(()=>{
    jobTimers.delete(id);const s=story(id),j=state.jobs[id];if(!s||!j)return;
    if(j.type==='write'){
      const text=buildText(s);
      if(used()+bytes(text)<=limitBytes)s.text=text;else notify('家庭空间已满，想法已保留。');
    }else if(used()+j.reserve+bytes(s.text)+1024<=limitBytes){
      advanceTour(3,4,id);
      s.recordings.unshift({id:uid(),title:s.title,text:s.text,voice:j.voice,duration:Math.max(5,Math.ceil([...s.text].length/(j.voice==='轻快晨读'?5:4))),bytes:j.reserve});
    }else notify('家庭空间不足，稿件已保留。');
    s.updated=Date.now();state.usage.push({at:Date.now(),type:j.type,config:j.config,chars:s.text.length});delete state.jobs[id];save();
    if(page==='edit'&&routeId===id||page==='create')render();
  },Math.max(0,job.due-Date.now())));
}
function resumeJobs(){Object.keys(state.jobs).forEach(schedule)}
function beginJob(s,type,voice){
  if(state.jobs[s.id])return;
  const config=configsFor(type).find(c=>c.preferred)||configsFor(type)[0];
  const queued=Object.values(state.jobs).filter(j=>j.config===config?.id);
  const today=new Date();today.setHours(0,0,0,0);const month=new Date(today);month.setDate(1);
  const recent=state.usage.filter(x=>x.config===config?.id);
  const chars=type==='voice'?s.text.length:buildText(s).length;
  if(config?.perDay && recent.filter(x=>x.at>=today).length+queued.length>=config.perDay ||
     config?.perStory && chars>config.perStory ||
     config?.perMonth && recent.filter(x=>x.at>=month).reduce((n,x)=>n+x.chars,0)+queued.reduce((n,j)=>n+j.chars,0)+chars>config.perMonth){
    go('edit',s.id);notify('已达到这项服务的用量限制。稿件已保留，可在家庭设置中调整。');return;
  }
  const reserve=type==='voice'?Math.ceil([...s.text].length/4)*8000:0;
  const pending=Object.values(state.jobs).reduce((n,j)=>n+(j.reserve||0),0);
  if(used()+pending+reserve+bytes(s.text)+1024>limitBytes){quotaMessage('空间不足，稿件已保留。');return;}
  state.jobs[s.id]={type,voice,reserve,config:config?.id,chars,due:Date.now()+1400};save();schedule(s.id);go('edit',s.id);
}
function quotaMessage(msg){
  dialog('家庭额度',`<p>${html(msg)}</p><p class="hint">故事 ${state.stories.length}/100 · 家人 ${state.people.length}/20 · 空间 ${(used()/1e6).toFixed(1)}/100 MB</p>`,act('dismiss','稍后整理')+submitBtn('整理作品'),()=>{accepted();studioTab='all';go('create')});
}
on('dismiss',closeDialog);
function library(){
  const stories=state.stories.filter(s=>(studioTab==='all'||(studioTab==='published'?s.published&&!s.archived:studioTab==='archive'?s.archived:!s.published&&!s.archived))&&(!libraryQuery||[s.title,s.series,s.idea].join(' ').includes(libraryQuery))&&(libraryChild==='all'||s.published?.kids.includes(libraryChild))).sort((a,b)=>b.updated-a.updated);
  return stories.length?stories.map(s=>`<div class="list-row"><img class="thumb" src="${cover(s.cover)}" alt=""><div class="grow"><h3>${html(s.title)}</h3><small>${state.jobs[s.id]?jobLabel(state.jobs[s.id]):s.archived?'已归档':s.published?'已发布':'草稿'}${s.series?' · '+html(s.series):''}</small></div>${act('edit','打开','secondary',s.id)}</div>`).join(''):empty('这里还没有故事','写下一句话，或者导入已有的故事。');
}
function studio(){
  return `<div class="wrap section-page">${coach(2)}${title('写故事','给孩子留下一封会说话的信。')}<div class="card"><div class="row between"><h2>${importMode?'导入故事':'今晚想讲什么？'}</h2>${act('mode',importMode?'从一个想法开始':'导入已有故事','light')}</div>
  <form id="new-story">${importMode?input('title','故事标题',sessionStorage.getItem('import-title')||'')+area('body','粘贴正文',sessionStorage.getItem('import-body')||''):area('idea','故事想法',sessionStorage.getItem('story-idea')||'',3)}
  ${!importMode?'<div class="row">'+['小狐狸第一次露营','一只在雨天送信的蜗牛'].map(t=>act('prompt',t,'light',t)).join('')+'</div>':''}
  <div class="actions">${submitBtn(importMode?'保存并审稿':'写故事')}</div></form></div>
  <div class="head"><h2>家庭内容库</h2></div><div class="tabs">${[['all','全部'],['draft','草稿'],['published','已发布'],['archive','已归档']].map(([v,t])=>act('studio-filter',t,'tab '+(studioTab===v?'on':''),v)).join('')}</div>
  <details><summary>查找作品</summary><form id="library-search">${input('query','标题、主题或系列',libraryQuery)}${pick('childfilter','发布给',[['all','全部听众'],...children().map(k=>[k.id,k.name])],libraryChild)}${submitBtn('查找')}</form></details>
  <div class="card">${library()}</div></div>`;
}
forms.set('library-search',d=>{libraryQuery=d.get('query').trim();libraryChild=d.get('childfilter');render()});
forms.set('new-story',data=>{
  const idea=(data.get(importMode?'title':'idea')||'').trim(),text=(data.get('body')||'').trim();
  if(!idea||(importMode&&!text))throw Error('请先填写'+(importMode?'标题和正文。':'故事想法。'));
  if(state.stories.length>=100){quotaMessage('书架已放满 100 个故事。');return;}
  if(used()+bytes(idea)+bytes(text)+1024>limitBytes){quotaMessage('家庭内容已达到 100 MB。');return;}
  const create=()=>{
    const s=makeStory(idea,text);state.stories.unshift(s);advanceTour(2,3,s.id);save();
    if(importMode){sessionStorage.removeItem('import-title');sessionStorage.removeItem('import-body');go('edit',s.id);}
    else{sessionStorage.removeItem('story-idea');beginJob(s,'write');}
  };
  if(importMode)create();else withService('write',create);
});
function editor(){
  const s=story(routeId);if(!s)return '<div class="wrap">'+empty('找不到这篇作品','回到内容库看看。',act('create','家庭内容库'))+'</div>';
  const job=state.jobs[s.id];
  if(job)return `<div class="wrap section-page"><div class="card wait" role="status"><span class="bob" aria-hidden="true">${icon('fox',50)}${icon(job.type==='write'?'pen':'headphones',28)}</span><h2>${jobLabel(job)}</h2><p>当前稿件已保存，可以稍后回来。</p><div class="bone"></div>${act('create','回内容库')}</div></div>`;
  return `<div class="wrap section-page">${state.tourV2?.story===s.id?coach(3)+coach(4):''}${act('create','家庭内容库','light')}<div class="head"><h1 style="font-size:2.2rem">故事工作台</h1><span class="pill">${s.archived?'已归档':s.published?'已发布 · 可继续改稿':'草稿'}</span></div>
  <div class="card"><form id="edit-form">${input('title','标题',s.title)}${area('text','故事正文',s.text,8)}
  <small id="save-state">草稿自动保存于当前浏览器</small><details><summary>封面、系列与版本</summary>${pick('cover','封面主题',covers,s.cover)}${input('series','系列',s.series)}
  <div class="check-list">${s.versions.map((v,i)=>act('restore','恢复「'+html(v.title)+'」 · '+new Date(v.at).toLocaleTimeString(),'secondary',String(i))).join('')||'保存版本后可在这里恢复。'}</div></details>
  <div class="actions">${submitBtn('保存版本')}${act('rewrite','改写一段','secondary')}${!s.text?act('regen','生成草稿','secondary'):''}</div></form></div>
  <div class="card"><h2>给故事配音</h2><p class="hint">前端评审使用设备中文朗读，文字和语音服务均可在家庭设置中预演。</p>
  ${pick('voice','声音',voices,state.prefs[state.kid]?.voice||voices[0][0])}<div class="actions">${act('short-preview','试听一句')}${act('record','生成朗读','primary')}</div>
  ${s.recordings.map(r=>`<div class="list-row"><div class="grow"><strong>${html(r.title)}</strong><div class="meta">${html(r.voice)} · 约 ${time(r.duration)}${s.published?.rid===r.id?' · 已发布':''}</div></div>${act('audition','试听','secondary',r.id)}${act('publish','放进书架','primary',r.id)}${act('drop-record','删除录音','light',r.id)}</div>`).join('')}</div>
  <details class="card"><summary>作品管理</summary><div class="actions">${act('sequel','写下一集')}${act('export','导出文本')}${act('archive',s.archived?'移出归档':'归档')}${s.published?act('unpublish','撤回发布'):''}${act('delete-story','删除作品','danger')}</div></details></div>`;
}
function storeForm(){
  const f=$('#edit-form'),s=story(routeId);if(!f||!s)return true;
  const d=new FormData(f),text=d.get('text'),title=d.get('title'),series=d.get('series');
  if(used()+bytes(text)+bytes(title)+bytes(series)-bytes(s.text)-bytes(s.title)-bytes(s.series)>limitBytes){notify('空间不足，新输入仍在编辑框内。');return false;}
  Object.assign(s,{text,title,series,cover:d.get('cover'),updated:Date.now()});save();return true;
}
function snapshot(s){const v={title:s.title,text:s.text,at:Date.now()};if(used()+bytes(JSON.stringify(v))>limitBytes)throw Error('空间不足，请先整理旧版本。');s.versions.unshift(v);save();}
pages.set('create',studio);pages.set('edit',editor);
on('mode',()=>{importMode=!importMode;render()});on('prompt',id=>{const field=$('[name=idea]');field.value=id;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus()});
on('edit',id=>go('edit',id));on('studio-filter',id=>{studioTab=id;render()});
document.addEventListener('input',e=>{
  if(e.target.closest('#new-story')){const key={title:'import-title',body:'import-body',idea:'story-idea'}[e.target.name];if(key)sessionStorage.setItem(key,e.target.value);}
  if(e.target.closest('#edit-form')&&storeForm())$('#save-state').textContent='已保存草稿';
});
document.addEventListener('change',e=>{if(e.target.closest('#edit-form'))storeForm()});
forms.set('edit-form',()=>{if(!storeForm())return;const s=story(routeId);if(!s.title.trim()||!s.text.trim())throw Error('请补全标题与正文。');snapshot(s);render();notify('版本已保存。')});
on('restore',index=>confirmAction('恢复此版本？','当前稿件会先保存为一个版本。','恢复',()=>{const s=story(routeId),v=s.versions[Number(index)];snapshot(s);s.text=v.text;s.title=v.title;save();render()}));
on('regen',()=>withService('write',()=>beginJob(story(routeId),'write')));
on('rewrite',()=>{
  const s=story(routeId),paras=s.text.split(/\n+/).filter(Boolean);if(!paras.length){notify('请先写下正文。');return;}
  dialog('改写一段',pick('paragraph','选择段落',paras.map((p,i)=>[String(i),p.slice(0,26)]),'0')+area('instruction','希望怎么改？','让语气更温柔',2),submitBtn('预览改写'),d=>{
    const idx=Number(d.get('paragraph')),wish=d.get('instruction').trim();
    const proposed=wish.includes('短')?paras[idx].split(/[，。]/)[0]+'。':'夜色轻轻落下来。'+paras[idx].replace(/[！!]/g,'。');
    dialog('确认改写',area('replacement','改写结果（可编辑）',proposed,4),submitBtn('替换这一段'),v=>{
      const edited=v.get('replacement').trim();if(!edited)throw Error('请输入正文。');const next=paras.map((p,i)=>i===idx?edited:p).join('\n\n');
      const previous={title:s.title,text:s.text,at:Date.now()};
      if(used()+bytes(JSON.stringify(previous))+bytes(JSON.stringify(next))-bytes(JSON.stringify(s.text))+2>limitBytes)throw Error('空间不足，请先整理旧版本。');
      snapshot(s);s.text=next;save();accepted();render();
    });
  });
});
on('short-preview',()=>sayPreview(story(routeId).text.split(/[。！？]/)[0]||'晚安，愿你做个好梦。',$('[name=voice]').value));
on('record',()=>{const s=story(routeId),v=$('[name=voice]').value;if(!s.text.trim()||!s.title.trim()){notify('请先补全标题和正文。');return;}
  const same=s.recordings.find(r=>r.text===s.text&&r.voice===v);if(same){notify('已找到相同朗读，可以直接试听或发布。');return;}
  withService('voice',()=>confirmAction('生成这篇朗读？',s.text.length+' 字 · '+v+'。本次使用本地预演，不会产生服务商费用。','生成朗读',()=>beginJob(s,'voice',v)));
});
async function sayPreview(text,style){
  stopPlayback();const token=speechRun,voice=await localMandarinVoice();
  if(token!==speechRun)return;
  if(!voice){notify('设备没有可用的普通话音色，可到首页试听内置录音。');return;}
  const chunks=narrationPhrases(text);let next=0;
  function read(){
    if(token!==speechRun||next>=chunks.length)return;
    const utterance=makeUtterance(chunks[next++],style,voice);
    utterance.onend=read;utterance.onerror=e=>{if(!['interrupted','canceled'].includes(e.error))notify('设备语音暂时不可用。')};
    deviceVoice().speak(utterance);
  }
  read();
}

on('audition',rid=>{const r=story(routeId).recordings.find(x=>x.id===rid);sayPreview(r.text,r.voice);dialog('试听朗读','<p>'+html(r.title)+' · '+html(r.voice)+'</p>',submitBtn('结束试听'),()=>{stopPlayback();accepted()},stopPlayback)});
on('publish',rid=>{const s=story(routeId);dialog('放进谁的书架？','<div class="check-list">'+children().map(k=>`<label><input type="checkbox" name="kids" value="${html(k.id)}" ${(s.published?.kids||[state.kid]).includes(k.id)?'checked':''}>${html(k.name)}</label>`).join('')+'</div>',submitBtn('确认发布'),d=>{const kids=d.getAll('kids');if(!kids.length)throw Error('至少选择一位听众。');s.published={rid,kids,cover:s.cover,title:s.title};s.archived=false;save();accepted();if(activeTour()&&state.tourV2.step===4&&state.tourV2.story===s.id){advanceTour(4,5,s.id);state.kid=kids.includes(state.kid)?state.kid:kids[0];save();go('shelf')}else render();notify('故事已放进所选孩子的书架。')})});
on('drop-record',id=>{const s=story(routeId);if(s.published?.rid===id){notify('请先撤回发布，再删除这版朗读。');return;}confirmAction('删除这版朗读？','稿件和其他朗读会保留。','删除',()=>{s.recordings=s.recordings.filter(r=>r.id!==id);save();render()})});
on('archive',()=>{const s=story(routeId);s.archived=!s.archived;save();render()});
on('unpublish',()=>confirmAction('从孩子书架撤回？','家长仍然可以编辑和重新发布。','撤回',()=>{story(routeId).published=null;stopPlayback();save();render()}));
on('delete-story',()=>confirmAction('删除整篇作品？','稿件、所有版本及朗读都会删除。','确认删除',()=>{const id=routeId;state.stories=state.stories.filter(s=>s.id!==id);delete state.jobs[id];if(now?.id===id)stopPlayback();save();go('create')}));
on('sequel',()=>{const s=story(routeId);if(state.stories.length>=100){quotaMessage('书架已满。');return;}const next=makeStory(s.title+' · 下一集','',s.series||s.title);next.cover=s.cover;next.idea='续写《'+s.title+'》：'+s.text.slice(-90);state.stories.unshift(next);save();go('edit',next.id)});
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
on('export',()=>{const s=story(routeId);download((s.title||'故事')+'.txt',s.title+'\n\n'+s.text,'text/plain;charset=utf-8')});
