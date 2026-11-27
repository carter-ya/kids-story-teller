// Hold the session request open so layout assertions do not depend on network speed.
import {verifyRouteLoading} from './route-loading.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function verifyHomeLayout({send,js,until,site,output}){
  await send('Page.enable');
  const guest=['.mast-inner','.mail-hero','.letterhead','.mail-copy h1','.mail-copy p','.mail-copy .actions button','.postcard','.postcard img','.postcard figcaption','.sample-shelf .head','.sample-shelf .cover','.sample-shelf .book-info','.visitor-steps'];
  const member=['.mast-inner','.hero','.hero-art','.hero-copy','.hero h1','.hero p','.hero .actions button','.head','.tabs','.grid .cover','.book-info'];
  async function geometry(selectors){
    return js(`Array.from(document.querySelectorAll(${JSON.stringify(selectors.join(','))}),node=>{const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`);
  }
  async function capture(name){
    if(!output)return;
    const shot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile(join(output,name+'.png'),Buffer.from(shot.data,'base64'));
  }
  for(const signed of [false,true]){
    const route=signed?'#shelf':'#welcome';
    const {identifier}=await send('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.fetch=async function(input){
        if(input==='/api/session'){
          await new Promise(resolve=>window.finishSession=resolve);
          return Response.json({cloud:true,family:${signed?"'fixture'":"null"},kid:${signed?"'kid'":"null"}});
        }
        if(input==='/api/library')return Response.json({revision:1,mediaBytes:0,state:firstState()});
        throw Error('Unexpected request in home layout test');
      };
    `});
    for(const width of [375,730,731,760,761,1280]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:width===375?812:900,deviceScaleFactor:1,mobile:false});
      await send('Page.navigate',{url:site+'?layout='+width+(signed?'m':'g')+route});
      await until(()=>js(`location.search===${JSON.stringify('?layout='+width+(signed?'m':'g'))}&&typeof finishSession==='function'`),'held session');
      assert.ok(await js("document.querySelector('#app').inert"));
      const selectors=signed?member:guest;
      if(!signed){
        assert.ok(await js(`['.postcard','.mail-hero','.sample-shelf .cover','.visitor-steps'].every(s=>{
          const style=getComputedStyle(document.querySelector(s));return style.borderBottomColor==='rgba(0, 0, 0, 0)'&&style.boxShadow==='none'
        })`));
      }
      const before=await geometry(selectors);
      assert.ok(before.length>=12);
      assert.ok(await js("getComputedStyle(document.querySelector('#app .cover')).backgroundImage.includes('linear-gradient')"));
      const band=await js(`(async()=>{
        const app=document.querySelector('#app'),sweep=app.getAnimations().find(a=>a.animationName==='home-sweep');
        sweep.pause();sweep.currentTime=450;
        const first=getComputedStyle(app.querySelector('.cover')).backgroundImage;
        sweep.currentTime=1100;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return first!==getComputedStyle(app.querySelector('.cover')).backgroundImage;
      })()`);
      assert.ok(band,'shimmer changes position within the masks');
      if(width===375||width===1280)await capture((signed?'shelf':'welcome')+'-'+width+'-loading');
      await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      assert.equal(await js("getComputedStyle(document.querySelector('#app .cover')).backgroundImage"),'none');
      await send('Emulation.setEmulatedMedia',{features:[]});
      await js('finishSession()');
      await until(()=>js("!document.querySelector('#app').inert"),'ready home');
      await js("Promise.all(Array.from(document.querySelectorAll('#app img'),img=>img.decode()))");
      const after=await geometry(selectors);
      assert.equal(after.length,before.length);
      for(let i=0;i<before.length;i++)for(let j=0;j<4;j++){
        assert.ok(Math.abs(before[i][j]-after[i][j])<=1,`${route} at ${width}px, element ${i} coordinate ${j}: ${before[i][j]} → ${after[i][j]}`);
      }
      assert.equal(await js("document.querySelector('#home-status')"),null);
      if(width===375||width===1280)await capture((signed?'shelf':'welcome')+'-'+width+'-ready');
      if(!signed && width===1280){
        const {x,y}=await js(`(()=>{const b=document.querySelector('.sample-shelf .cover');b.scrollIntoView({block:'center'});
          const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
        await until(()=>js("getComputedStyle(document.querySelector('.listen-dot')).backgroundColor==='rgb(167, 64, 41)'"),'hovered play marker');
        await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x,y});
        await until(()=>js("getComputedStyle(document.querySelector('.listen-dot')).backgroundColor==='rgb(36, 51, 72)'"),'pressed play marker');
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y});
        await until(()=>js("location.hash==='#player/fox'&&!!document.querySelector('#seek')"),'card opened player');
      }
    }
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  }
  await verifyRouteLoading({send,js,until,site,capture});
  console.log('PASS · loading and ready geometry at six viewport widths on both home pages');
}
