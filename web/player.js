let now=null, isPlaying=false, speechPos=0, speechClock=0, speechRun=0, sleepUntil=0, lastStamp=0;
const deviceVoice=()=>window.speechSynthesis;
const position=()=>!now?0:now.audio?(audio.currentTime||0):Math.min(now.duration,speechPos+(isPlaying?(Date.now()-speechClock)/1000:0));
function remember(force=false){
  if(!signedIn || !now || now.preview || (!force && Date.now()-lastStamp<5000))return;
  state.progress[keyFor(now)]={pos:position(),at:Date.now()};lastStamp=Date.now();save();
}
function stopPlayback(keepTimer=false){
  if(now)remember(true);
  speechRun++;deviceVoice()?.cancel();audio.pause();audio.removeAttribute('src');audio.load();
  now=null;isPlaying=false;speechPos=0;if(!keepTimer){clearTimeout(sleepTimer);sleepUntil=0;}
  updateMini();
}
function pausePlayback(){
  if(!now)return;
  const pos=position();speechRun++;deviceVoice()?.cancel();audio.pause();
  isPlaying=false;speechPos=pos;remember(true);syncPlayer();
}
function ended(){
  isPlaying=false;speechPos=0;audio.currentTime=0;remember(true);syncPlayer();
  if(now?.preview)return;
  if(now && state.prefs[state.kid]?.continuous){
    const items=listed();const idx=items.findIndex(i=>i.id===now.id);
    if(idx>=0 && items[idx+1])openPlayer(items[idx+1].id,true);
  }
}
async function speak(){
  if(!deviceVoice()){notify('此浏览器没有设备朗读功能，可以读正文或播放书架上的录音。');return;}
  const token=++speechRun;deviceVoice().cancel();
  const voice=await localMandarinVoice();
  if(token!==speechRun||!now)return;
  if(!voice){notify('设备没有可用的普通话音色，可阅读正文或试听内置录音。');return;}
  const chunks=narrationPhrases(now.text);
  const size=chunks.reduce((n,c)=>n+c.length,0);
  let chars=Math.floor(size*speechPos/now.duration),idx=0;
  while(idx<chunks.length-1 && chars>=chunks[idx].length)chars-=chunks[idx++].length;
  const line=()=>{
    if(token!==speechRun||!now)return;
    if(idx>=chunks.length){ended();return;}
    const u=makeUtterance(chunks[idx++].slice(chars),now.voice,voice);chars=0;
    u.onend=line;u.onerror=e=>{if(token!==speechRun||['interrupted','canceled'].includes(e.error))return;pausePlayback();notify('设备语音不可用，可以展开正文阅读。')};
    deviceVoice().speak(u);
  };
  isPlaying=true;speechClock=Date.now();line();syncPlayer();
}
async function play(){
  if(!now)return;
  if(!now.audio){speak();return;}
  try{await audio.play();isPlaying=true;}catch{isPlaying=false;notify('播放未开始，请点播放键再试。');}syncPlayer();
}
function seek(pos){if(!now)return;pos=Math.max(0,Math.min(now.duration,pos));if(now.audio){if(audio.readyState)audio.currentTime=pos;}else{const playing=isPlaying;pausePlayback();speechPos=pos;if(playing)speak();}remember(true);syncPlayer();}
function loadItem(item,preview=false){
  if(now?.id===item.id && now?.recording===item.recording && now?.preview===preview)return;
  stopPlayback(true);now={...item,preview};const pos=preview?0:state.progress[keyFor(item)]?.pos||0;
  if('mediaSession' in navigator && 'MediaMetadata' in window)navigator.mediaSession.metadata=new MediaMetadata({title:item.title,artist:'晚安邮局',artwork:[{src:new URL(item.cover,location.href).href,type:'image/webp'}]});
  if(item.audio){audio.src=item.audio;const id=item.id;audio.onloadedmetadata=()=>{if(now?.id!==id)return;now.duration=audio.duration||item.duration;audio.currentTime=Math.min(pos,now.duration-.1);syncPlayer()};}
  else speechPos=pos>=item.duration?0:pos;
}
function openPlayer(id,auto){
  const item=listed().find(i=>i.id===id);if(!item)return;
  loadItem(item,!signedIn);go('player',id);if(auto)play();
}
function updateMini(){
  const mini=$('#mini');
  mini.hidden=!now||page==='player'||now.preview;
  if(mini.hidden){delete mini.dataset.view;return;}
  const view=JSON.stringify([now.id,now.title,isPlaying]);if(mini.dataset.view===view)return;
  mini.dataset.view=view;mini.innerHTML=act('reopen',html(now.title),'')+act('toggle',icon(isPlaying?'pause':'play',18)+(isPlaying?'暂停':'播放'),'light')+'<button class="icon" data-act="stop" aria-label="停止播放">'+icon('close')+'</button>';
}
function syncPlayer(){
  if(page==='player' && now){
    const range=$('#seek');if(range){range.max=now.duration;range.value=position();}
    if($('#buffering'))$('#buffering').hidden=!now.audio||audio.readyState>=3||audio.error;
    if($('#clock'))$('#clock').textContent=time(position())+' / '+time(now.duration);
    const button=$('#play-button');
    if(button){button.setAttribute('aria-label',isPlaying?'暂停':'播放');button.dataset.playing=String(isPlaying);}
    const knob=$('#seek');if(knob)knob.style.setProperty('--played',(100*(position()/(now.duration||1)))+'%');
  }
  updateMini();
}
function playerPage(){
  const item=listed().find(i=>i.id===routeId);
  if(!item)return '<div class="wrap">'+empty('这篇故事已离开书架','回到书架挑一篇吧。',act('back-shelf','我的书架'))+'</div>';
  loadItem(item,!signedIn);
  const bedtime=sleepUntil?'定时已开启':'睡眠定时';
  return `<div class="wrap listening-room"><div class="room-nav">${act('back-shelf',icon('chevron-left',18)+(signedIn?'我的书架':'返回首页'),'room-back')}
    <span>${icon('moon',19)} 晚安放映室</span></div>
    <section class="storybook-player" aria-label="绘本故事播放器">
      <div class="player-stage"><span class="stage-star star-one" aria-hidden="true">${icon('sparkle',45)}</span><span class="stage-star star-two" aria-hidden="true">${icon('sparkle',24)}</span>
        <figure class="story-window"><img src="${item.cover}" alt="${html(item.title)}的故事插画"><figcaption>${icon('envelope',18)} 晚安邮局</figcaption></figure><span class="stage-moon" aria-hidden="true">${icon('moon',48)}</span>
      </div>
      <div class="radio-face"><div class="fox-tab" aria-hidden="true">${icon('fox',56)}</div><p class="radio-series">${icon('headphones',18)} ${html(item.theme)}</p>
        <h1>${html(item.title)}</h1><p class="radio-source">${item.audio?'普通话故事录音':'设备中文朗读'}</p>
        <div class="sound-track"><label class="sr-only" for="seek">播放进度</label><input id="seek" type="range" min="0" max="${now.duration}" step=".1" value="${position()}"><div id="clock" class="meta"></div></div>
        <div class="transport"><button data-act="rewind" aria-label="后退 10 秒">${icon('skip-back',26)}<small>10 秒</small></button>
        <button id="play-button" class="play-disc" data-act="toggle" aria-label="播放"><span class="show-play">${icon('play',32)}</span><span class="show-pause">${icon('pause',32)}</span></button>
        <button data-act="forward" aria-label="前进 10 秒">${icon('skip-forward',26)}<small>10 秒</small></button></div>
        <div class="radio-tools">${act(signedIn?'fav':'login',icon(signedIn&&liked(item.id)?'heart-fill':'heart',20)+(signedIn&&liked(item.id)?'已收藏':'收藏'),'radio-tool',item.id)}${act('timer',icon('timer',20)+bedtime,'radio-tool')}</div>
        <p id="buffering" class="hint" role="status" hidden>${icon('paw',16)} 正在取回录音…</p>
      </div></section>
      <details class="transcript"><summary>${icon('book',22)} 读故事正文</summary><p class="quote">${html(item.text)}</p>${item.audio?'<a class="secondary" href="'+item.audio+'" download>保存这段录音</a>':''}</details>
      ${!signedIn?'<div class="listen-invite"><p>也给孩子写一篇自己的故事。</p>'+act('login','开启家庭书架','primary')+'</div>':''}
  </div>`;
}
pages.set('player',playerPage);
on('listen',id=>openPlayer(id,true));on('reopen',()=>now&&go('player',now.id));
on('toggle',()=>isPlaying?pausePlayback():play());on('stop',()=>{stopPlayback();render()});
on('back-shelf',()=>{if(!signedIn)stopPlayback();go(signedIn?'shelf':'welcome')});on('rewind',()=>seek(position()-10));on('forward',()=>seek(position()+10));
on('timer',()=>dialog('睡眠定时',pick('minutes','多久后暂停',[['0','关闭定时','sun'],['5','5 分钟','moon'],['15','15 分钟','moon'],['30','30 分钟','moon']],sleepUntil?'15':'0'),submitBtn('保存'),data=>{
  clearTimeout(sleepTimer);const mins=Number(data.get('minutes'));sleepUntil=mins?Date.now()+mins*60000:0;
  if(mins)sleepTimer=setTimeout(()=>{pausePlayback();sleepUntil=0;render()},mins*60000);
  accepted();render();
}));
document.addEventListener('change',e=>{if(e.target.id==='seek')seek(Number(e.target.value))});
audio.addEventListener('ended',ended);
for(const event of ['waiting','canplay','playing'])audio.addEventListener(event,syncPlayer);
audio.addEventListener('timeupdate',()=>{if(now?.audio){remember();syncPlayer()}});
audio.addEventListener('pause',()=>{if(now?.audio){isPlaying=false;syncPlayer()}});
audio.addEventListener('play',()=>{if(now?.audio){isPlaying=true;syncPlayer()}});
audio.addEventListener('error',()=>{if(now?.audio&&audio.getAttribute('src')){isPlaying=false;syncPlayer();notify('录音加载失败，请重新打开这篇故事。')}});
setInterval(()=>{if(now&&!now.audio&&isPlaying){syncPlayer();remember()}},1000);
window.addEventListener('pagehide',()=>remember(true));
if('mediaSession' in navigator){
  for(const [action,handler] of Object.entries({play,pause:pausePlayback,seekbackward:()=>seek(position()-10),seekforward:()=>seek(position()+10)})){
    try{navigator.mediaSession.setActionHandler(action,handler)}catch{}
  }
}
