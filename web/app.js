'use strict';
const $ = selector => document.querySelector(selector);
const html = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Array.from(crypto.getRandomValues(new Uint32Array(3)),n=>n.toString(36)).join('');
const act = (name,label,cls='secondary',id='') => `<button type="button" class="${cls}" data-act="${name}" data-id="${html(id)}">${label}</button>`;
const cover = id => SAMPLES.find(s=>s.id===id)?.cover || SAMPLES[0].cover;
const input = (name,label,value='',limit=160) => `<label class="field">${label}<input name="${name}" maxlength="${limit}" value="${html(value)}"></label>`;
const area = (name,label,value='',rows=5) => `<label class="field">${label}<textarea name="${name}" rows="${rows}" maxlength="60000">${html(value)}</textarea></label>`;
const time = n => Math.floor((n||0)/60)+':'+String(Math.floor(n||0)%60).padStart(2,'0');
const actions = new Map();
const on = (name,fn) => actions.set(name,fn);
const forms = new Map();
const pages = new Map();
const audio = $('#audio');
let state, database, page='shelf', routeId='', adult=sessionStorage.getItem('post-office-adult')==='yes', filter='all', familyTab='members', studioTab='all';
let modalSubmit, modalCancel, noticeTimer, pendingGate, sleepTimer;
const firstState=()=>({version:1,people:[{id:'owner',name:'家长',kind:'成人'},{id:'kid',name:'小米',kind:'孩子'}],kid:'kid',stories:[],configs:[],prefs:{},favorites:{},progress:{},guided:false,jobs:{},usage:[]});
const child=()=>state.people.find(m=>m.id===state.kid);
const children=()=>state.people.filter(m=>m.kind==='孩子');
const story=id=>state.stories.find(s=>s.id===id);
const sample=id=>SAMPLES.find(s=>s.id===id);
const bytes=text=>new Blob([text]).size;
function used(){
  if(cloud)return bytes(JSON.stringify(state))+cloudMedia;
  return state.stories.reduce((n,s)=>n+bytes(JSON.stringify([s.title,s.idea,s.text,s.versions,s.series,s.recordings.map(r=>[r.title,r.text,r.voice])]))+s.recordings.reduce((a,r)=>a+r.bytes,0),0);
}
const limitBytes=100000000;
let persistenceFailed=false;
async function load(){
  try{
    database=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('goodnight-post-office',1);
      req.onupgradeneeded=()=>req.result.createObjectStore('family');
      req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);
    });
    state=await new Promise((resolve,reject)=>{const r=database.transaction('family').objectStore('family').get('state');r.onsuccess=()=>resolve(r.result||firstState());r.onerror=()=>reject(r.error)});
  }catch{state=firstState();persistenceFailed=true;notify('此浏览器未开放本地存储，本次数据仅在页面内保留。');}
}
function save(){
  if(cloud){if(adult)markCloud();return;}
  if(!database)return;
  try{
    const tx=database.transaction('family','readwrite');
    tx.objectStore('family').put(state,'state');
    tx.onabort=()=>notify('浏览器空间不足，请导出当前作品。');
  }catch{notify('保存失败，请先导出当前作品。');}
}
function notify(msg){clearTimeout(noticeTimer);$('#notice').textContent=msg;noticeTimer=setTimeout(()=>$('#notice').textContent='',3200);}
function dialog(title,body,buttons,submit,cancel){
  const dlg=$('#dialog');
  if(dlg.open)dlg.close();
  $('#dialog-title').textContent=title;$('#dialog-body').innerHTML=body;
  $('#dialog-actions').innerHTML=buttons;$('#dialog-error').textContent='';
  modalSubmit=submit;modalCancel=cancel;dlg.showModal();
}
const submitBtn=(label)=>'<button type="submit" class="primary">'+label+'</button>';
function closeDialog(){const cancel=modalCancel;modalCancel=null;modalSubmit=null;$('#dialog').close();$('#dialog-body').replaceChildren();cancel?.();}
function accepted(){modalCancel=null;closeDialog();}
function confirmAction(title,info,label,fn){
  dialog(title,'<p>'+html(info)+'</p>','<button type="button" class="secondary" data-close>取消</button>'+submitBtn(label),()=>{accepted();fn()});
}
function fieldSecret(name,label){
  return `<div class="field secret"><label for="secret-${name}">${label}</label><div class="row"><span class="mascot" aria-hidden="true">${icon('fox',38)}</span><input autocomplete="off" type="password" id="secret-${name}" name="${name}" maxlength="512" class="text"><button type="button" class="icon" data-eye aria-label="显示${label}" aria-pressed="false">${icon('eye-off')}</button></div></div>`;
}
function gate(fn){
  if(!signedIn){login();return;}
  if(adult){fn();return;}
  if(cloud){cloudLogin(fn,true);return;}
  pendingGate=fn;
  dialog('进入家长区','<p>评审用家长口令为 <strong>1234</strong>。</p>'+fieldSecret('pin','家长口令'),submitBtn('解锁'),data=>{
    if(data.get('pin')!=='1234')throw Error('口令不对，再试一次。');
    const next=pendingGate;accepted();adult=true;sessionStorage.setItem('post-office-adult','yes');pendingGate=null;next();
  },()=>{pendingGate=null;if(['create','family','edit','services'].includes(page))go('shelf')});
}
function go(name,id=''){
  const hash='#'+name+(id?'/'+encodeURIComponent(id):'');
  if(location.hash===hash)navigate();else location.hash=hash;
}
function navigate(){
  if(!state)return;
  if($('#dialog').open)closeDialog();
  const [raw,id='']=location.hash.slice(1).split('/');
  let name=pages.has(raw)?raw:(signedIn?'shelf':'welcome');
  if(!signedIn && !(name==='player' && sample(id)))name='welcome';
  if(signedIn && name==='welcome')name='shelf';
  if(name==='guide'&&state.tourV2?.step!==1){resumeTour();return;}
  if(['create','family','edit','services','guide'].includes(name)&&!adult){
    page='shelf';routeId='';render();
    gate(()=>go(name,id));return;
  }
  page=name;routeId=id;render();scrollTo(0,0);
}
function render(){
  frontHeader();
  document.body.classList.toggle('night',page==='player');
  document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('current',b.dataset.nav===(page==='edit'?'create':page==='services'?'family':page==='player'?'shelf':page)));
  $('#profile').innerHTML='<span class="avatar" aria-hidden="true">'+icon('rabbit',27)+'</span>'+html(child()?.name||'选择听众');
  $('#app').innerHTML=pages.get(page)();
  updateMini?.();if(page==='player')syncPlayer();
}
function listed(){
  if(!signedIn)return SAMPLES;
  return [...state.stories.filter(s=>s.published?.kids.includes(state.kid)&&!s.archived).map(s=>{
    const r=s.recordings.find(r=>r.id===s.published.rid);
    return r?{id:s.id,title:s.published.title||r.title,text:r.text,cover:cover(s.published.cover),theme:s.series||'家庭原创',duration:r.duration,recording:r.id,audio:r.cloud?'/api/audio/'+encodeURIComponent(r.id):undefined,voice:r.voice}:null;
  }).filter(Boolean),...SAMPLES];
}
function keyFor(item){return [state.kid,item.id,item.recording||'sample'].join(':')}
function liked(id){return (state.favorites[state.kid]||[]).includes(id)}
function shelf(){
  const items=listed();
  const featured=items.slice().sort((a,b)=>(state.progress[keyFor(b)]?.at||0)-(state.progress[keyFor(a)]?.at||0))[0];
  const pos=state.progress[keyFor(featured)]?.pos||0;
  let rows=filter==='fav'?items.filter(i=>liked(i.id)):filter==='home'?items.filter(i=>!sample(i.id)):items;
  return `<div class="wrap">${coach(5)}${activeTour()&&adult&&state.tourV2.step<5?act('resume-tour','接着上次的新手引导','light'):''}<section class="hero"><div class="hero-copy"><span class="eyebrow">${pos?'接着上次听':'今晚的枕边故事'}</span><h1>${html(featured.title)}</h1><p>${html(featured.text.split(/[。！？]/)[0])}。</p><div class="actions">${act('listen',icon('play',18)+(pos?'继续听 · '+time(pos):'听这个故事'),'primary',featured.id)}</div></div><button class="hero-art" data-act="listen" data-id="${html(featured.id)}" aria-label="播放${html(featured.title)}"><img src="${featured.cover}" alt=""></button></section>
  <section><div class="head"><h2>${html(child()?.name||'家庭')}的书架</h2><div class="tabs">${[['all','全部故事'],['fav','我喜欢的'],['home','家庭原创']].map(([v,n])=>act('filter',n,'tab '+(filter===v?'on':''),v)).join('')}</div></div>
  ${rows.length?'<div class="grid">'+rows.map(i=>`<article class="book"><button class="cover" data-act="listen" data-id="${html(i.id)}" aria-label="播放${html(i.title)}"><img src="${i.cover}" alt=""></button><div class="book-info"><div><button class="book-title titleface" data-act="listen" data-id="${html(i.id)}">${html(i.title)}</button><div class="meta">${html(i.theme)} · ${time(i.duration)}</div></div><button class="heart" data-act="fav" data-id="${html(i.id)}" aria-label="收藏${html(i.title)}" aria-pressed="${liked(i.id)}">${icon(liked(i.id)?'heart-fill':'heart',23)}</button></div></article>`).join('')+'</div>':empty(filter==='fav'?'喜欢的故事会放在这里':'书架等着第一篇家庭故事',filter==='fav'?'点故事旁的小爱心就能收藏。':'家长发布后，孩子就能在这里听。',filter==='home'?act('create','写一篇故事','primary'):act('filter','看看全部故事','secondary','all'))}</section></div>`;
}
function empty(title,body,button=''){return `<div class="empty"><div class="art" aria-hidden="true">${icon('book',44)}</div><h3>${html(title)}</h3><p class="hint">${html(body)}</p>${button}</div>`}
function title(h,desc=''){return `<div class="page-title"><h1>${html(h)}</h1>${desc?'<p>'+html(desc)+'</p>':''}</div>`}
pages.set('shelf',shelf);
on('filter',id=>{filter=id;render()});
on('fav',id=>{const arr=state.favorites[state.kid]||=[];if(liked(id))arr.splice(arr.indexOf(id),1);else arr.push(id);listenerChange(id,{favorite:liked(id)});save();render()});
on('create',()=>gate(()=>go('create')));
function switchKid(id){if(cloud){if(adult)return changeCloudRole(id);accepted();return;}stopPlayback();state.kid=id;save();adult=false;sessionStorage.removeItem('post-office-adult');accepted();go('shelf');}
$('#profile').onclick=()=>dialog('谁来听故事？','<div class="check-list">'+children().map(k=>act('switch-kid',icon('rabbit')+html(k.name)+(k.id===state.kid?icon('check',16):''),'secondary',k.id)).join('')+'</div>',act('manage-profile','管理听众'),null);
on('switch-kid',switchKid);
on('manage-profile',()=>{accepted();gate(()=>go('family'))});
document.addEventListener('click',e=>{
  const eye=e.target.closest('[data-eye]');
  if(eye){const field=eye.closest('.secret'),box=field.querySelector('input');box.type=box.type==='password'?'text':'password';eye.innerHTML=icon(box.type==='text'?'eye':'eye-off');eye.setAttribute('aria-pressed',String(box.type==='text'));eye.setAttribute('aria-label',box.type==='text'?'隐藏内容':'显示内容');return;}
  if(e.target.closest('[data-close]')){closeDialog();return;}
  const nav=e.target.closest('[data-nav]');if(nav){if(nav.dataset.nav==='shelf')go('shelf');else gate(()=>go(nav.dataset.nav));return;}
  const b=e.target.closest('[data-act]');if(b)Promise.resolve().then(()=>actions.get(b.dataset.act)?.(b.dataset.id,b)).catch(e=>notify(e.message));
});
document.addEventListener('focusin',e=>{const f=e.target.closest('.secret');if(f)f.querySelector('.mascot').innerHTML=icon('fox-cover',38)});
document.addEventListener('focusout',e=>{const f=e.target.closest('.secret');if(f&&!f.contains(e.relatedTarget)){f.querySelector('input').type='password';f.querySelector('.mascot').innerHTML=icon('fox',38);const b=f.querySelector('[data-eye]');b.innerHTML=icon('eye-off');b.setAttribute('aria-pressed','false');b.setAttribute('aria-label','显示内容');}});
document.addEventListener('submit',async e=>{e.preventDefault();const f=e.target;try{if(f.id==='dialog-form'){await modalSubmit?.(new FormData(f),f)}else await forms.get(f.id)?.(new FormData(f),f)}catch(err){if($('#dialog').open)$('#dialog-error').textContent=err.message;else notify(err.message);}});
$('#dialog').addEventListener('cancel',e=>{e.preventDefault();closeDialog()});
window.addEventListener('hashchange',navigate);
window.addEventListener('DOMContentLoaded',async()=>{try{if(!await cloudBoot())await load();}catch(e){$('#app').textContent=e.message||'打开书架失败，请刷新重试。';return;}document.querySelectorAll('[data-symbol]').forEach(el=>el.innerHTML=icon(el.dataset.symbol));resumeJobs();navigate()});
