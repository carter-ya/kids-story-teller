const capabilities=[['write','写故事','pen'],['voice','讲故事','music']];
const typeName=type=>type==='write'?'写故事':'讲故事';
const configsFor=type=>(cloud?[...cloudServices,...(cloudAdult==='owner'?state.configs:[])]:state.configs).filter(c=>c.type===type);
const memberCount=()=>state.people.length+(cloud?cloudAccounts.filter(a=>!a.pending).length:0);
function family(){
  const count=memberCount(),size=used();
  let inner='';
  if(familyTab==='members'){
    inner='<div class="card"><div class="row between"><h2>我的家人</h2>'+((!cloud||cloudAdult==='owner')?act('member','添加家人','primary'):'')+'</div>'+state.people.map(p=>`<div class="list-row"><span class="avatar">${icon(p.kind==='孩子'?'rabbit':'sun',27)}</span><div class="grow"><strong>${html(p.name)}</strong><div class="meta">${p.id==='owner'?'家庭管理员':p.kind}</div></div>${p.kind==='孩子'?act('kid-prefs','听故事偏好','secondary',p.id):''}${p.id==='owner'||(cloud&&cloudAdult!=='owner')?'':act('remove-member','移除','light',p.id)}</div>`).join('')+'</div>';
    if(cloud){
      inner+='<div class="card"><h3>成人账户与邀请</h3>'+cloudAccounts.map(a=>'<div class="list-row"><span class="grow">'+html(a.name)+(a.pending?' · 等待加入':' · 成人')+'</span>'+(cloudAdult==='owner'?act('revoke-adult','撤销访问','light',a.id):'')+'</div>').join('')+(cloudAdult==='owner'?act('invite-adult','邀请成人')+act('rotate-owner','更换管理员登录码','light'):'')+'</div>';
    }
    if(state.invites?.length)inner+='<div class="card"><h3>等待加入</h3>'+state.invites.map(i=>'<div class="list-row"><strong class="grow">'+html(i.name)+'</strong>'+act('accept-invite','预演接受邀请','secondary',i.id)+act('cancel-invite','取消','light',i.id)+'</div>').join('')+'</div>';
  }else if(familyTab==='services')inner=serviceList();
  else{
    const since=new Date();since.setDate(1);since.setHours(0,0,0,0);
    const logs=state.usage.filter(e=>e.at>=since.getTime());
    inner='<div class="card"><h2>家庭用量</h2><div class="usage">'+[['故事',state.stories.length,100,'篇'],['家人',count,20,'人'],['空间',+(size/1e6).toFixed(2),100,'MB']].map(([n,v,max,unit])=>`<div class="meter">${n}<strong>${v} / ${max} ${unit}</strong><progress value="${v}" max="${max}" aria-label="${n}用量"></progress></div>`).join('')+'</div><p class="hint">' + (cloud?'空间包括家庭稿件与录音。删除录音后，后台会回收已释放的空间。':'内置绘本由平台提供。设备朗读按预估大小计入模拟空间。') + '</p><p>本月写故事 '+logs.filter(j=>j.type==='write').length+' 次，朗读 '+logs.filter(j=>j.type==='voice').reduce((n,j)=>n+j.chars,0)+' 字。</p><div class="actions">'+act('create','整理作品')+act('family-export','导出家庭故事')+'</div></div>';
  }
  return `<div class="wrap section-page">${title('我的家庭','家长专用空间')}<div class="tabs">${[['members','家人'],['services','模型与声音'],['usage','用量']].map(([v,n])=>act('family-tab',n,'tab '+(familyTab===v?'on':''),v)).join('')}</div>${inner}
  <div class="card"><div class="row between"><div><h3>家庭书架使用帮助</h3><p class="meta">${cloud?'使用家庭登录码可在其他设备打开书架。':'本地体验数据保存在此浏览器。'}</p></div><div class="row">${act('guide','新手引导')}${act('logout','退出登录','light')}${act('lock','交给孩子','primary')}</div></div></div></div>`;
}
function serviceList(){
  return '<div class="card"><h2>模型与声音</h2><p class="hint">' + (cloud?'家长选择平台，填一次密钥，就能开始使用。':'此处预演服务配置，密钥字段仅用于体验输入。') + '</p>'+capabilities.map(([t,n])=>'<div class="head"><h3>'+n+'</h3>'+act('add-config','添加配置','light',t)+'</div>'+
    (configsFor(t).map(c=>`<div class="list-row"><div class="grow"><strong>${html(c.name)}</strong> ${c.preferred?'<span class="pill">默认</span>':''}<div class="meta">${html(c.model||providerName(c.provider)+' 配音')} · ${c.share?'家庭成人可使用':'仅自己使用'}</div></div>${!c.preferred?act(c.managed?'service-default':'default-config','设为默认','light',c.id):''}${!c.managed||c.owner===cloudAdult?act(c.managed?'service-edit':'config-edit','编辑','secondary',c.id)+act(c.managed?'service-delete':'config-delete','删除','light',c.id):''}</div>`).join('')||'<p class="meta">尚未配置，首次使用时可连接服务。</p>')).join('')+(cloud&&cloudAdult==='owner'&&state.configs.length?'<div class="actions">'+['openai','deepseek'].map(p=>act('forget-key','移除 '+providerName(p)+' 密钥','light',p)).join('')+'</div>':'')+'</div>';
}
pages.set('family',family);
on('lock',()=>{if(cloud)return changeCloudRole(state.kid);stopPlayback();adult=false;sessionStorage.removeItem('post-office-adult');go('shelf')});on('family-tab',id=>{familyTab=id;render()});
on('member',()=>{
  if(memberCount()>=20){notify('家人已满 20 人，可先在「家人」中整理。');return;}
  dialog('添加家人',pick('kind','身份',cloud?[['孩子','孩子','rabbit']]:[['孩子','孩子','rabbit'],['成人','成人照护者','sun']],'孩子')+input('name','昵称','',24),submitBtn('添加'),async d=>{
    const name=d.get('name').trim();if(!name)throw Error('请输入昵称。');
    if(memberCount()>=20)throw Error('本家庭最多可容纳 20 人。');
    if(cloud){
      await flushCloud();
      const member={id:uid(),name,kind:'孩子'};
      const next={...state,people:[...state.people,member]};
      const row=await api('library','PUT',{revision:cloudRevision,state:next});
      cloudRevision=row.revision;state.people.push(member);accepted();render();return;
    }
    else if(d.get('kind')==='成人'){(state.invites||=[]).push({id:uid(),name});notify('本地邀请已创建，可在等待加入列表预演接受。');}
    else state.people.push({id:uid(),name,kind:'孩子'});
    save();accepted();render();
  });
});
on('cancel-invite',id=>{state.invites=state.invites.filter(i=>i.id!==id);save();render()});
on('accept-invite',id=>{
  if(memberCount()>=20){notify('家人已满，先整理成员名额再接受邀请。');return;}
  const invite=state.invites.find(i=>i.id===id);if(!invite)return;
  state.people.push({...invite,kind:'成人'});state.invites=state.invites.filter(i=>i.id!==id);save();render();notify('已加入家庭。');
});
on('remove-member',id=>{
  const p=state.people.find(x=>x.id===id);if(!p||id==='owner')return;
  if(p.kind==='孩子'&&children().length===1){notify('请先添加另一位听众，再移除当前听众。');return;}
  confirmAction('移除「'+p.name+'」？','该成员的书架授权和个人偏好也会移除。','移除',()=>{
    state.people=state.people.filter(x=>x.id!==id);delete state.prefs[id];delete state.favorites[id];
    for(const k of Object.keys(state.progress))if(k.startsWith(id+':'))delete state.progress[k];
    state.stories.forEach(s=>{if(s.published){s.published.kids=s.published.kids.filter(k=>k!==id);if(!s.published.kids.length)s.published=null;}});
    if(state.kid===id){stopPlayback();state.kid=children()[0].id;}save();render();
  });
});
on('kid-prefs',id=>{
  const p=state.people.find(x=>x.id===id),pref=state.prefs[id]||{};
  dialog('听故事偏好',((cloud&&cloudAdult!=='owner')?'<p>'+html(p.name)+'</p>':input('name','昵称',p.name,24))+pick('age','年龄段',[['不限','不限'],['3–5 岁','3–5 岁'],['6–8 岁','6–8 岁'],['9 岁以上','9 岁以上']],pref.age)+pick('voice','默认声音',voices,pref.voice)+input('avoid','希望避开的内容',pref.avoid||'')+'<label class="row"><input type="checkbox" name="continuous" '+(pref.continuous?'checked':'')+'>播完后继续下一篇</label>',submitBtn('保存偏好'),d=>{
    if(d.has('name')&&(!cloud||cloudAdult==='owner')){const name=d.get('name').trim();if(!name)throw Error('请填写昵称。');p.name=name;}
    state.prefs[id]={age:d.get('age'),voice:d.get('voice'),avoid:d.get('avoid'),continuous:d.has('continuous')};save();accepted();render();
  });
});
function configDialog(type,existing,after){
  if(cloud)return cloudConfig(type,existing,after);
  const c=existing||{name:typeName(type)+'示例',model:type==='write'?'story-local':'voice-local',endpoint:'',share:false};
  const body=pick('provider','服务商',[['sample','内置示例','fox'],['custom','自定义服务','pen']],c.provider||'sample')+
    input('name','配置名称',c.name)+input('model','模型名称',c.model)+
    '<div id="custom-fields" '+(c.provider==='custom'?'':'hidden')+'>'+input('endpoint','服务地址（HTTPS）',c.endpoint,350)+fieldSecret('key','示例密钥')+'</div>'+
    '<details><summary>用量限制</summary>'+input('perDay','每天最多生成几次（留空不限）',c.perDay||'',6)+input('perStory','每篇最多字数（留空不限）',c.perStory||'',6)+(type==='voice'?input('perMonth','每月最多配音字数（留空不限）',c.perMonth||'',10):'')+'</details>'+
    '<label class="row"><input type="checkbox" name="share" '+(c.share?'checked':'')+'>允许家庭成人使用</label><p class="hint">当前为本地预演，请使用示例值。密钥离开此表单即清除。</p>'+
    act('test-config','测试当前配置','light')+'<p id="test-result" role="status"></p>';
  dialog('连接'+typeName(type)+'服务',body,submitBtn(after?'保存并继续':'保存配置'),d=>{
    validateConfig(d);
    const record={id:c.id||uid(),type,name:d.get('name').trim(),model:d.get('model').trim(),perDay:Number(d.get('perDay')),perStory:Number(d.get('perStory')),perMonth:Number(d.get('perMonth')),provider:d.get('provider'),endpoint:d.get('provider')==='custom'?d.get('endpoint').trim():'',share:d.has('share'),preferred:existing?c.preferred:!configsFor(type).length};
    if(existing)state.configs[state.configs.indexOf(existing)]=record;else state.configs.push(record);
    save();accepted();if(after)after();else render();
  });
}
function validateConfig(d){
  for(const name of ['perDay','perStory','perMonth']){
    const raw=d.get(name);if(raw && (!/^\d+$/.test(raw)||Number(raw)<1))throw Error('用量限制请输入大于零的整数，或留空。');
  }
  if(!d.get('name')?.trim()||!d.get('model')?.trim())throw Error('请填写配置名称和模型名称。');
  if(d.get('provider')==='custom'){
    let url;try{url=new URL(d.get('endpoint'))}catch{}
    if(!url||url.protocol!=='https:')throw Error('请输入完整的 HTTPS 服务地址。');
  }
}
document.addEventListener('change',e=>{if(e.target.name==='provider'&&$('#custom-fields'))$('#custom-fields').hidden=e.target.value!=='custom'});
on('test-config',async(id,b)=>{
  const result=$('#test-result');try{
    validateConfig(new FormData($('#dialog-form')));b.disabled=true;result.innerHTML=icon('paw')+' 正在检查…';
    await new Promise(r=>setTimeout(r,380));result.textContent='格式检查通过 · 前端预演未连接外部服务。';
  }catch(err){result.textContent=err.message;}finally{b.disabled=false;}
});
function withService(type,callback){if(configsFor(type).length)callback();else configDialog(type,null,callback);}
on('add-config',type=>configDialog(type));on('config-edit',id=>{const c=state.configs.find(c=>c.id===id);configDialog(c.type,c)});
on('default-config',id=>{const c=state.configs.find(x=>x.id===id);configsFor(c.type).forEach(x=>x.preferred=x.id===id);save();render()});
on('config-delete',id=>{const c=state.configs.find(x=>x.id===id);confirmAction('删除这项配置？','已有故事和已发布朗读仍可使用。','删除',()=>{state.configs=state.configs.filter(x=>x.id!==id);const list=configsFor(c.type);if(list.length&&!list.some(x=>x.preferred))list[0].preferred=true;save();render()})});
on('family-export',()=>download('晚安邮局-家庭故事.json',JSON.stringify(state.stories,null,2),'application/json'));
