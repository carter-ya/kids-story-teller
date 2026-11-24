// One local review household. The signed-in session and the family PIN are separate.
let signedIn = sessionStorage.getItem('post-office-login') === 'yes';
function frontHeader(guest = !signedIn) {
  $('.brand').href = guest ? '#welcome' : '#shelf';
  $('.mast nav').hidden = guest;
  $('#profile').hidden = guest;
  $('#sign-in').hidden = !guest;
}
// The public landing page is already laid out in index.html at first paint.
const welcomeLayout = $('#app .welcome')||$('#guest-cache').content.firstElementChild;
for(const holder of welcomeLayout.querySelectorAll('[data-home-icon]')){
  holder.innerHTML=icon(holder.dataset.homeIcon,Number(holder.dataset.size));
}
const sampleGrid=welcomeLayout.querySelector('.sample-shelf .grid');
const sampleCard=sampleGrid.firstElementChild;
sampleGrid.replaceChildren(...SAMPLES.map(sample=>{
  const card=sampleCard.cloneNode(true);
  const cover=card.querySelector('.cover');
  cover.setAttribute('aria-label','试听'+sample.title);
  cover.querySelector('img').src=sample.cover;
  for(const button of card.querySelectorAll('[data-act]'))button.dataset.id=sample.id;
  card.querySelector('.book-title .home-ink').textContent=sample.title;
  card.querySelector('.meta .home-ink').textContent=sample.theme+' · '+time(sample.duration);
  return card;
}));
function welcome(){return welcomeLayout.outerHTML;}
pages.set('welcome',welcome);

function login() {
  if(cloud)return cloudLogin();
  dialog('登录家庭书架','<p class="hint">前端评审使用本机的家庭体验账号，登录后可继续这个浏览器里的作品。</p>'+fieldSecret('login','体验口令')+'<p class="hint">体验口令：<strong>1234</strong></p>',submitBtn('登录并继续'),data=>{
    if(data.get('login')!=='1234')throw Error('请输入体验口令 1234。');
    accepted();stopPlayback();signedIn=true;adult=true;
    sessionStorage.setItem('post-office-login','yes');sessionStorage.setItem('post-office-adult','yes');
    if(!state.tourV2)state.tourV2={step:1};
    save();resumeTour();
  });
}
on('login', login);
on('logout',()=>{
  if(cloud)return cloudLogout();
  accepted();stopPlayback();signedIn=false;adult=false;filter='all';
  sessionStorage.removeItem('post-office-adult');sessionStorage.removeItem('post-office-login');go('welcome');
});
on('guest-listen',id=>openPlayer(id,true));

function activeTour(){return signedIn && state.tourV2?.step>0 && state.tourV2.step<=5;}
function resumeTour() {
  const tour=state.tourV2;
  if(!activeTour()){go('shelf');return;}
  if(tour.step===1){go('guide');return;}
  if(tour.step===2||!story(tour.story)){tour.step=2;save();go('create');return;}
  if(tour.step===5){go('shelf');return;}
  go('edit',tour.story);
}
const tourSteps=[
  ['为谁寄故事？','给小听众取个昵称。这会出现在孩子自己的书架上。'],
  ['写下第一个想法','点选一个灵感或写下自己的，随后点「写故事」。也可以导入已有的故事。'],
  ['读稿，再给故事配音','读一遍故事，可以直接改字。满意后在「给故事配音」点「生成朗读」。'],
  ['把朗读放进书架','可以先试听，再点录音旁的「放进书架」，选一位听众。'],
  ['点开第一封声音来信','故事已发布。点下方按钮，打开刚刚做好的一篇。']
];
function coach(step){
  const t=state.tourV2;if(!activeTour()||t.step!==step)return '';
  const [heading,body]=tourSteps[step-1];
  return `<aside class="coach" aria-label="新手引导 第 ${step} 步"><div class="coach-face">${icon('fox',46)}</div><div class="grow"><small>新手引导 · ${step} / 5</small><h3>${heading}</h3><p>${body}</p>${step===5?act('tour-listen',icon('play',16)+' 听我写的故事','primary'):''}</div>${act('skip-guide','跳过','quiet')}</aside>`;
}
pages.set('guide',()=>`<div class="wrap section-page">${coach(1)}<form id="guide-family" class="card">
  ${input('nickname','小听众的昵称',child().name,24)}${submitBtn('下一步，写故事')}</form></div>`);
forms.set('guide-family',d=>{
  const name=d.get('nickname').trim();if(!name)throw Error('请填写一个昵称。');
  if(!cloud||cloudAdult==='owner')child().name=name;state.tourV2={step:2};save();go('create');
});
function advanceTour(from,to,id){
  if(!activeTour()||state.tourV2.step!==from)return;
  if(from>2&&id!==state.tourV2.story)return;
  state.tourV2={step:to,story:id};save();
}
on('resume-tour',resumeTour);
on('guide',()=>{state.tourV2={step:1};save();resumeTour()});
on('skip-guide',()=>{state.tourV2={step:0};save();if(page==='guide')go('shelf');else render()});
on('tour-listen',()=>{
  const s=story(state.tourV2?.story);
  if(!s?.published){go('create');return;}
  if(!s.published.kids.includes(state.kid))state.kid=s.published.kids[0];
  state.tourV2={step:0};save();openPlayer(s.id,true);
});
