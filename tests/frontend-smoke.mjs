// Run against a running static preview, using a separate temporary Chrome profile.
import {verifyHomeLayout} from './home-layout.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const fixture=process.argv.includes('--cloud')?await (await import('./email-browser-fixture.mjs')).emailBrowserFixture():null;
const site = fixture?.url || process.argv[2] || 'http://127.0.0.1:8000/';
const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'story-ui-'));
const child = spawn(chrome, ['--headless','--disable-gpu','--disable-background-networking','--no-first-run','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let socket;
const errors = [];
async function until(check, label) {
  for(let n=0;n<100;n++){try{if(await check())return;}catch(e){if(!/navigated|context was destroyed/i.test(e.message))throw e;}await sleep(100);}
  throw Error('Timed out waiting for '+label);
}
try {
  let port;
  await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return true;}catch{return false;}},'Chrome');
  const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((yes,no)=>{socket.onopen=yes;socket.onerror=no});
  let sequence=0;const replies=new Map();
  socket.onmessage=({data})=>{
    const m=JSON.parse(data);if(m.id){const [yes,no]=replies.get(m.id);replies.delete(m.id);if(m.error)no(Error(m.error.message));else yes(m.result);}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
  };
  function send(method,params={}){
    const id=++sequence;return new Promise((yes,no)=>{replies.set(id,[yes,no]);socket.send(JSON.stringify({id,method,params}))});
  }
  async function js(expression){
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }
  async function reload(){const before=await js('performance.timeOrigin');await send('Page.reload');await until(async()=>{const after=await js('performance.timeOrigin');return after!==before;},'fresh document');}
  const exists=selector=>until(()=>js('!!document.querySelector('+JSON.stringify(selector)+')'),selector);
  async function click(selector){await exists(selector);await js('document.querySelector('+JSON.stringify(selector)+').click()');}
  async function pressAt(selector,touch=false){
    const point=await js(`(()=>{
      const el=document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block:'nearest'});
      const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      if(!el.contains(document.elementFromPoint(x,y)))throw Error('Control is covered');
      return {x,y};
    })()`);
    if(touch){
      await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else{
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
  }
  async function fill(selector,value){await exists(selector);await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);}
  async function captureDesign(name){
    if(!process.env.STORY_DESIGN_SHOTS)return;
    await send('Page.enable');
    const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:80});
    await writeFile(join(process.env.STORY_DESIGN_SHOTS,name+'.jpg'),Buffer.from(shot.data,'base64'));
  }
  await send('Runtime.enable');
  await send('Page.enable');
  if(fixture)await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.EventSource=class extends EventSource{
      constructor(...args){super(...args);this.addEventListener('message',()=>window.seenStoryStream=true);}
    };
    window.turnstile={render(el,opts){queueMicrotask(()=>opts.callback('fixture-'+crypto.randomUUID()));return 'fixture-widget'},remove(){}};
  `});
  if(process.argv.includes('--home-layout')){
    await verifyHomeLayout({send,js,until,site,output:process.env.STORY_SCREENSHOTS});
    assert.deepEqual(errors,[]);
  }else{
  if(process.env.STORY_DESIGN_SHOTS)await send('Emulation.setDeviceMetricsOverride',{width:1280,height:880,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:site});
  await exists('#app:not([inert]) .mail-hero');
  assert.equal(await js("document.querySelector('.mast nav').hidden"),true);
  await click('[data-act=browse-samples]');
  await until(()=>js("document.querySelector('.sample-shelf').getBoundingClientRect().top<innerHeight/2"),'sample navigation');
  await click('[data-act=guest-listen]');
  await until(()=>js('document.querySelector("audio").currentTime>0'),'guest sample playback');
  await exists('#play-button[data-playing=true] .show-pause svg');
  await captureDesign('player');
  await click('.transcript summary');
  await captureDesign('letter');
  await click('[data-act=timer]');await fill('[name=minutes]','17');await click('#dialog-actions [type=submit]');
  await until(()=>js("document.querySelector('#sleep-label').textContent.includes('暂停')"),'custom sleep timer');
  await click('[data-act=timer]');assert.equal(await js("document.querySelector('[name=minutes]').value"),'17');
  await click('[data-act=cancel-sleep]');assert.equal(await js("document.querySelector('.transcript').open"),true);
  assert.equal(await js("Object.keys(state.progress).length"),0);
  await click('[data-act=back-shelf]');await exists('.welcome');
  if(process.argv.includes('--cloud')){
    const owner='parent@example.test',member='carer@example.test';
    async function verifyMailbox(email){
      await fixture.advanceCooldown(email);
      await fill('[name=email]',email);await click('#dialog-actions [type=submit]');
      await until(async()=>{const error=await js("document.querySelector('#dialog-error').textContent");if(error)throw Error(error);return js("!!document.querySelector('[name=code]')")},'mail code entry');
      assert.equal(await js("document.querySelector('[data-resend]').disabled"),true);
      await fill('[name=code]',fixture.code(email));await click('#dialog-actions [type=submit]');
    }
    await click('#sign-in');
    if(process.env.STORY_LOGIN_SCREENSHOT){
      await send('Page.enable');
      const image=await send('Page.captureScreenshot',{format:'jpeg',quality:75});
      await (await import('node:fs/promises')).writeFile(process.env.STORY_LOGIN_SCREENSHOT,Buffer.from(image.data,'base64'));
    }
    await verifyMailbox(owner);await exists('#guide-family');
    await fill('[name=nickname]','云端听众');await click('#guide-family [type=submit]');await exists('#new-story');
    await click('[data-act=mode]');await fill('[name=title]','云端故事');await fill('[name=body]','小兔轻声说晚安。');
    await click('#new-story [type=submit]');await exists('#edit-form');await js('flushCloud()');
    await reload();await exists('#edit-form');
    assert.equal(await js("document.querySelector('[name=title]').value"),'云端故事');
    await click('[data-nav=create]');await fill('[name=idea]','消防车嘟嘟，播放时长2小时左右的故事，给3岁孩子讲不同的场景和英文单词。');
    await click('#new-story [type=submit]');await fill('[name=key]','browser-fixture-only');await click('#dialog-actions [type=submit]');
    const seesDraft=()=>js("document.querySelector('[data-reader-draft]')?.textContent.includes('嘟嘟打开车灯')");
    await until(seesDraft,'live chapter text before completion');
    assert.match(await js("document.querySelector('[data-reader-saved]').textContent"),/第2章 第2站/);
    await reload();await until(seesDraft,'restored live chapter');
    await js('scrollTo(0,300)');const readingY=await js('scrollY');
    fixture.advanceDraft();
    await until(()=>js("document.querySelector('[data-reader-draft]')?.textContent.includes('小兔跳上车')"),'second streamed paragraph');
    assert.equal(await js('scrollY'),readingY);
    await click('[data-act=jump-draft]');
    await captureDesign('live-writing');
    assert.equal(await js("window.seenStoryStream===true"),true);
    fixture.finishDraft();
    await until(()=>js("!!document.querySelector('[data-act=finish-reading]:not([hidden]),[data-act=open-chapter]')"),'completed reader');
    if(await js("!!document.querySelector('[data-act=finish-reading]:not([hidden])')"))await click('[data-act=finish-reading]');
    await exists('[data-act=open-chapter]');
    assert.equal(await js("document.querySelector('[name=title]').value"),'嘟嘟的小城巡游');
    assert.equal(await js("manuscriptChapters(document.querySelector('[name=text]').value).length"),24);
    await js('flushCloud()');await reload();await exists('[data-act=open-chapter]');
    if(process.env.STORY_DESIGN_SHOTS){
      await js("document.querySelector('[data-act=open-chapter]').scrollIntoView({block:'center'})");
      await captureDesign('chapter-recording');
    }
    await click('[aria-controls=pick-record-chapter-options]');await click('#pick-record-chapter-options [data-value="1"]');await click('[data-act=open-chapter]');
    await exists('[data-act=record]');
    assert.equal(await js("document.querySelector('[name=title]').value"),'第2章 第2站');
    assert.ok(await js("document.querySelector('[name=text]').value.length<=4000"));
    await js('flushCloud()');
    await click('[data-nav=family]');await click('[data-act=family-tab][data-id=services]');
    await click('[data-act=add-config][data-id=voice]');
    assert.equal(await js("document.querySelector('[name=keyFrom]').value"),await js("cloudServices.find(s=>s.type==='write').id"));
    assert.equal(await js("document.querySelector('[name=key]').disabled"),true);
    await captureDesign('key-reuse');
    const keyPicker='[aria-controls=pick-keyFrom-options]';
    const newKey='#pick-keyFrom-options [data-value=""]';
    const savedKey='#pick-keyFrom-options [role=option]';
    let documented=false;
    async function checkManualEntry(){
      assert.equal(await js("document.querySelector('[name=keyFrom]').value"),'');
      assert.equal(await js("document.activeElement===document.querySelector('[name=key]') && document.activeElement.checkVisibility() && document.activeElement.required"),true);
      if(!documented){await captureDesign('manual-key-entry');documented=true;}
      await send('Input.insertText',{text:'test-manual-entry'});
      assert.equal(await js("new FormData(document.querySelector('#dialog-form')).get('key')"),'test-manual-entry');
    }
    for(const touch of [false,true]){
      if(touch){
        await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
        await send('Emulation.setTouchEmulationEnabled',{enabled:true});
      }
      await pressAt(keyPicker,touch);await pressAt(newKey,touch);
      await checkManualEntry();
      await pressAt(keyPicker,touch);await pressAt(savedKey,touch);
      assert.equal(await js("document.querySelector('[name=key]').disabled && !document.querySelector('[name=key]').value"),true);
    }
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await send('Emulation.clearDeviceMetricsOverride');
    await js("document.querySelector('[aria-controls=pick-keyFrom-options]').focus()");
    for(const key of ['End','Enter']){
      await send('Input.dispatchKeyEvent',{type:'keyDown',key});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key});
    }
    await checkManualEntry();
    await pressAt(keyPicker);await pressAt(savedKey);
    await click('#dialog-actions [type=submit]');
    await until(()=>js("cloudServices.some(s=>s.type==='voice') && !document.querySelector('#dialog').open"),'saved narration with writing key');
    await click('[data-act=family-tab][data-id=members]');await click('[data-act=lock]');await exists('.hero-art');
    assert.equal(await js("adult"),false);
    assert.equal(await js("state.stories.length"),0);
    await click('[data-nav=create]');await verifyMailbox(owner);await exists('#new-story');
    await click('[data-nav=family]');await click('[data-act=invite-adult]');await fill('[name=name]','测试照护者');
    await click('#dialog-actions [type=submit]');await exists('textarea[readonly]');const invite=await js("document.querySelector('textarea[readonly]').value");
    await click('#dialog-actions [type=submit]');await click('[data-act=logout]');await exists('.welcome');
    await send('Page.navigate',{url:invite});await verifyMailbox(member);await exists('#app:not([inert]) .coach');
    await click('[data-nav=family]');await exists('[data-act=logout]');
    assert.equal(await js("document.querySelector('[data-act=remove-member],[data-act=erase-family]')===null"),true);
    await click('[data-act=logout]');await exists('.welcome');
    await click('#sign-in');await verifyMailbox(owner);await exists('#edit-form');
    await click('[data-nav=family]');await click('[data-act=revoke-adult]');await click('#dialog-actions [type=submit]');
    await until(()=>js("document.querySelector('[data-act=revoke-adult]')===null"),'adult removed');
    await click('[data-act=erase-family]');await fill('[name=confirm]','删除整个家庭');await click('#dialog-actions [type=submit]');await exists('.welcome');
    assert.equal(await js('signedIn'),false);assert.deepEqual(errors,[]);
    console.log('PASS · cloud household creation, onboarding, 24-chapter writing, model title after reload, chapter recording draft, child isolation, adult login, one-time invitation, removal, archive permissions and confirmed erasure');
  }else{
  await click('#sign-in');
  await click('#dialog-actions [type=submit]');await exists('#guide-family');
  await fill('[name=nickname]','小桃');await click('#guide-family [type=submit]');await exists('#new-story');
  assert.match(await js("document.querySelector('.coach').textContent"),/2 \/ 5/);
  await reload();await exists('#new-story');
  await fill('[name=idea]','云朵上的晚餐');await click('#new-story [type=submit]');
  await click('[role=combobox]');await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await fill('[name=endpoint]','https://example.org/v1');await fill('[name=key]','test-placeholder');
  await click('#dialog-actions [type=submit]');await exists('#edit-form');
  assert.match(await js("document.querySelector('.coach').textContent"),/3 \/ 5/);
  assert.equal(await js("document.querySelector('[name=title]').value"),'小狐狸的羽毛来信');
  await fill('[name=text]','小狐狸在云朵上吃晚餐。晚安。');await click('#edit-form [type=submit]');
  await click('[data-act=record]');await click('#dialog-actions [type=submit]');await click('#dialog-actions [type=submit]');
  await exists('[data-reader-saved]');assert.equal(await js("document.querySelector('[data-reader-saved]').textContent"),'小狐狸在云朵上吃晚餐。晚安。');
  await exists('[data-act=publish]');assert.match(await js("document.querySelector('.coach').textContent"),/4 \/ 5/);await click('[data-act=publish]');await click('#dialog-actions [type=submit]');
  await exists('[data-act=tour-listen]');await click('[data-act=tour-listen]');
  await exists('.storybook-player');assert.equal(await js('state.tourV2.step'),0);
  await click('[data-nav=family]');await click('[data-act=member]');
  await fill('#dialog [name=name]','新听众');await click('#dialog-actions [type=submit]');
  await click('[data-act=lock]');await exists('.hero-art img');
  await click('.cover[data-id=fox]');
  await until(()=>js("document.querySelector('audio').currentTime>0"),'sample playback');
  await click('[data-act=back-shelf]');await exists('#mini:not([hidden]) .mini-story');
  await click('#mini [data-act=toggle]');
  await until(()=>js("document.querySelector('#mini .mini-play').dataset.playing==='false'"),'paused dock');
  assert.equal(await js("document.querySelector('#mini .mini-story strong').textContent"),'月亮邮差');
  assert.match(await js("document.querySelector('#mini .mini-clock').textContent"),/\d+:\d{2} \/ \d+:\d{2}/);
  if(process.env.STORY_DESIGN_SHOTS)await until(()=>js("!document.querySelector('#notice').textContent"),'cleared notification');
  await captureDesign('mini');
  await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:false});
  assert.ok(await js("(()=>{const r=document.querySelector('#mini').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"));
  await captureDesign('mini-mobile');
  await click('#mini [data-act=reopen]');await exists('#play-button[data-playing=false]');
  assert.equal(await js("document.querySelector('#mini').hidden"),true);
  assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"));
  await captureDesign('player-mobile');
  await click('[data-act=back-shelf]');await exists('#mini:not([hidden]) .mini-close');
  await click('#mini [data-act=stop]');await until(()=>js("document.querySelector('#mini').hidden"),'closed dock');
  assert.equal(await js("document.querySelectorAll('.book').length"),4);
  await click('[data-act=fav]');await click('[data-act=filter][data-id=fav]');
  assert.equal(await js("document.querySelectorAll('.book').length"),1);
  await reload();await exists('#app:not([inert]) .hero-art img');
  assert.equal(await js("document.querySelectorAll('.book').length"),4);
  assert.equal(await js("JSON.stringify(state).includes('test-placeholder')"),false);
  await click('#profile');await js("Array.from(document.querySelectorAll('[data-act=switch-kid]')).find(b=>b.textContent.includes('新听众')).click()");
  assert.equal(await js("document.querySelectorAll('.book').length"),3);
  await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true);
  assert.equal(await js("document.querySelectorAll('select').length"),0);
  await click('[data-nav=create]');await click('#dialog-actions [type=submit]');
  await exists('#new-story');
  await js("while(state.stories.length<100)state.stories.push(makeStory('名额边界'));");
  await fill('[name=idea]','名额已满仍保留');await click('#new-story [type=submit]');
  assert.match(await js("document.querySelector('#dialog-body').textContent"),/100 个故事/);
  await click('[data-act=dismiss]');
  await js("state.stories=state.stories.slice(0,1);state.stories[0].recordings[0].bytes=100000000;");
  await click('#new-story [type=submit]');assert.match(await js("document.querySelector('#dialog-body').textContent"),/100 MB/);
  await click('[data-act=dismiss]');await click('[data-nav=family]');
  await js("while(state.people.length<20)state.people.push({id:uid(),kind:'成人',name:'边界成员'});");
  await click('[data-act=member]');assert.match(await js("document.querySelector('#notice').textContent"),/20 人/);
  await click('[data-act=guide]');await exists('#guide-family');await click('[data-act=skip-guide]');
  await exists('.hero-art img');await click('[data-nav=family]');await click('[data-act=logout]');await exists('.welcome');
  await send('Page.navigate',{url:site+'#edit/private'});await exists('.welcome');assert.equal(await js("!!document.querySelector('#edit-form')"),false);
  await click('#sign-in');await click('#dialog-actions [type=submit]');await exists('.hero-art img');
  assert.deepEqual(errors,[]);
  console.log('PASS · guest landing/audio, login, five-step onboarding, skip/replay, guest route isolation, playback, parent unlock, custom picker, create/edit/record/publish, members, child access, persistence, mobile layout, all three family quotas');
  }
  }
} finally {
  await fixture?.close();
  socket?.close();
  const stopped=new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve)});
  child.kill();await Promise.race([stopped,sleep(2000)]);
  await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
