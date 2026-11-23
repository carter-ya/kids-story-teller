import test from 'node:test';
import assert from 'node:assert/strict';
import {narrate,sections,writeStory} from '../server/providers.mjs';

function connection(provider,eventLog,fail){
  return async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer sample-value');
    assert.equal(new URL(url).hostname,'api.'+provider+'.com');
    const socket=new EventTarget();
    const message=data=>socket.dispatchEvent(new MessageEvent('message',{data}));
    socket.accept=()=>{};socket.close=()=>{};
    socket.send=str=>{
      const e=JSON.parse(str);eventLog.push(e);
      queueMicrotask(()=>{
        if(e.type==='session.update')message(JSON.stringify({type:'session.updated'}));
        if(e.type==='response.create'){
          message(JSON.stringify({type:'response.output_audio.delta',delta:'AAAAAA=='}));
          message(JSON.stringify({type:'response.done',response:{status:fail?'incomplete':'completed'}}));
        }
        if(e.event==='finish_text'){
          message(new Uint8Array(4).buffer);
          message(JSON.stringify({event:'finish',code:fail?'service_error':'success'}));
        }
      });
    };
    return {webSocket:socket};
  };
}
for(const provider of ['openai','deepseek']){
  test(provider+' requires a complete audio response and packages PCM as WAV',async()=>{
    const events=[],job={provider,style:'温柔晚安',input:'小狐狸，晚安。',reserve:10000};
    const blob=await narrate(job,'sample-value',connection(provider,events,false));
    assert.equal(blob.size,48);const wav=new DataView(await blob.arrayBuffer());
    assert.equal(wav.getUint32(24,true),24000);assert.equal(wav.getUint32(40,true),4);
    if(provider==='openai'){assert.equal(events[0].session.audio.output.voice,'marin');assert.equal(events[1].response.input[0].content[0].text,job.input);}
    else assert.deepEqual(events,[{event:'text',text:job.input},{event:'finish_text'}]);
    await assert.rejects(narrate(job,'sample-value',connection(provider,[],true)));
  });
}
test('segmentation preserves every character and punctuation',()=>{
  const text='月亮。\n小狐狸轻轻说：“晚安！”'+ '光'.repeat(400);
  assert.equal(sections(text,20).join(''),text);assert.ok(sections(text,20).every(x=>x.length<=20));
});
test('writing rejects incomplete answers and preserves the supplied model',async()=>{
  const job={provider:'deepseek',input:'月光下的兔子',model:'deepseek-flash'};
  const mock=async(_url,req)=>{
    assert.equal(JSON.parse(req.body).model,job.model);
    return Response.json({choices:[{finish_reason:'length',message:{content:'一半'}}]});
  };
  await assert.rejects(writeStory(job,'fictional',mock));
});
