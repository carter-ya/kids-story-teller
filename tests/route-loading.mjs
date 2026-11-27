import assert from 'node:assert/strict';

export async function verifyRouteLoading({send,js,until,site,capture}){
  const {identifier}=await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.fetch=async path=>{
      if(path==='/api/session'){
        await new Promise(r=>window.releaseSession=r);
        return Response.json({cloud:true,family:'fixture',kid:null,adult:'owner'});
      }
      if(path==='/api/library'){
        await new Promise(r=>window.releaseLibrary=r);
        const state=firstState();state.tourV2={step:1};state.stories=[makeStory('测试用稿件')];state.stories[0].id='draft';
        return Response.json({state,revision:1,mediaBytes:0});
      }
      if(path==='/api/configs')return Response.json([]);
      throw Error('Unexpected route loading request: '+path);
    };`});
  const routes=[
    ['player/fox','player','.listening-room','.transport'],
    ['create','create','.writing-desk','#new-story'],
    ['edit/draft','edit','.editing-desk','#edit-form'],
    ['guide','guide','.guide-loading-form','#guide-family'],
    ['family','family','.household','[data-act=invite-adult]'],
    ['join/invite-'+'a'.repeat(64),'join','.join-loading-form','dialog[open] [name=email]']
  ];
  for(const width of [375,1280]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:860,deviceScaleFactor:1,mobile:false});
    for(const [hash,name,shape,ready] of routes){
      const search='?route-test='+width+name;
      await send('Page.navigate',{url:site+search+'#'+hash});
      await until(()=>js(`location.search===${JSON.stringify(search)} && typeof releaseSession==='function'`),'held route session');
      const selector='#app[data-loading-page="'+name+'"][inert] '+shape;
      assert.ok(await js('!!document.querySelector('+JSON.stringify(selector)+')'));
      assert.equal(await js("!!document.querySelector('#app .welcome,#app .family-shelf')"),false);
      assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true);
      await js('releaseSession()');
      await until(()=>js("typeof releaseLibrary==='function'"),'held library');
      assert.ok(await js('!!document.querySelector('+JSON.stringify(selector)+')'));
      if(name==='player')await capture('player-'+width+'-loading');
      await js('releaseLibrary()');
      await until(()=>js('!document.querySelector("#app").inert && !!document.querySelector('+JSON.stringify(ready)+')'),'ready '+name);
    }
  }
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  console.log('PASS · distinct player, studio, editor, family, onboarding and invitation skeletons across both boot requests');
}
