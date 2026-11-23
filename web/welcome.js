// One local review household. The signed-in session and the family PIN are separate.
let signedIn = sessionStorage.getItem('post-office-login') === 'yes';
function frontHeader() {
  const guest = !signedIn;
  $('.brand').href = guest ? '#welcome' : '#shelf';
  $('.mast nav').hidden = guest;
  $('#profile').hidden = guest;
  $('#sign-in').hidden = !guest;
}
function welcome() {
  return `<div class="wrap welcome">
    <section class="mail-hero">
      <div class="mail-copy"><div class="letterhead">${icon('envelope')} 家庭有声故事书架</div>
        <h1>把晚安，<br><em>讲成故事。</em></h1>
        <p>从孩子今天的一个小念头开始。你来写、你来挑声音，把讲好的故事放进专属书架，明晚还能接着听。</p>
        <div class="actions">${act('login','开启家庭书架','primary')}${act('guest-listen',icon('play',18)+' 先听一篇','secondary','fox')}</div>
      </div>
      <figure class="postcard"><img src="assets/fox.webp" alt="小狐狸背着邮包，走在月光下的森林里"><figcaption><span>${icon('moon',19)} 月亮邮差</span><span class="postmark">${icon('mail',24)} 晚安邮局</span></figcaption></figure>
    </section>
    <section class="sample-shelf"><div class="head"><div><h2>先听听，今晚的故事</h2><p class="hint">三封可以直接打开的声音来信。</p></div></div><div class="grid">
      ${SAMPLES.map(s=>`<article class="book"><button class="cover" data-act="guest-listen" data-id="${s.id}" aria-label="试听${html(s.title)}"><img src="${s.cover}" alt=""><span class="listen-dot">${icon('play',20)}</span></button><div class="book-info"><div><button class="book-title titleface" data-act="guest-listen" data-id="${s.id}">${html(s.title)}</button><p class="meta">${html(s.theme)} · ${time(s.duration)}</p></div></div></article>`).join('')}
    </div></section>
    <section class="visitor-steps"><h2>从一个念头，到枕边的声音</h2><div class="grid">
      ${[['pen','写下奇思妙想','说一句想法，或带来自己写的故事。'],['headphones','听过，再放进书架','家长读稿、修改，试听满意后发布。'],['shelf','让孩子自己挑','点熟悉的封面就能听，喜欢的故事可以收藏。']].map(([sym,h,p])=>`<div>${icon(sym,34)}<h3>${h}</h3><p>${p}</p></div>`).join('')}
    </div></section></div>`;
}
pages.set('welcome',welcome);

function login() {
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
  ['写下第一个想法','点选一个灵感或写下自己的，随后点「写故事」。首次配置可直接使用内置示例。'],
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
  child().name=name;state.tourV2={step:2};save();go('create');
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
