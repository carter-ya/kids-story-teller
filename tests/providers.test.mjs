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

test('timed short drafts retry an undersized body and keep the model title separate',async()=>{
  const job={provider:'deepseek',kind:'write',input:'松鼠和花生，朗读时长1分钟',model:'fixture'};
  let calls=0;
  const result=await writeStory(job,'fixture',async(url,req)=>{
    const {messages}=JSON.parse(req.body);
    calls++;
    if(calls===2)assert.match(messages.at(-1).content,/实际为 2 个朗读字/);
    const text=calls===1?'松鼠。':'松鼠找花生。'.repeat(36);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'花生藏在哪',text})}}]});
  });
  assert.equal(calls,2);assert.equal(result.title,'花生藏在哪');assert.equal(result.text,'松鼠找花生。'.repeat(36));
});

test('ambiguous time expressions distinguish listening time from time within the plot',async()=>{
  const {writeStep}=await import('../server/story-writing.mjs');
  const derived=await writeStep({kind:'write',input:'消防车嘟嘟，想听一个半钟头'},async prompt=>{
    if(prompt.includes('提取'))return '{"minutes":90}';
    assert.match(prompt,/18 章/);
    return JSON.stringify({title:'灯亮了',chapters:Array.from({length:18},(_,i)=>({title:'小灯'+i,scene:'路过一盏灯'}))});
  });
  assert.equal(derived.outline.minutes,90);
  const short=await writeStep({kind:'write',input:'小狐狸等了两个小时才见到小鸟'},async prompt=>
    prompt.includes('提取')?'{"minutes":null}':'{"title":"窗前的小鸟","text":"小鸟来了。"}');
  assert.deepEqual(short,{title:'窗前的小鸟',text:'小鸟来了。'});
});

test('invalid model titles, incomplete outlines and persistently short timed chapters fail visibly',async()=>{
  const {writeStep}=await import('../server/story-writing.mjs');
  await assert.rejects(writeStep({kind:'write',input:'小兔'},async()=>JSON.stringify({title:'兔'.repeat(25),text:'晚安。'})),/格式不完整/);
  const job={kind:'write',input:'故事时长10分钟'};
  await assert.rejects(writeStep(job,async()=>'{"title":"嘟嘟","chapters":[]}'),/格式不完整/);
  let calls=0;
  await assert.rejects(writeStep({...job,completed:0,result:'',outline:JSON.stringify({minutes:10,chapters:[{title:'嘟嘟出发',scene:'出发'}]})},async()=>{calls++;return '出发了。'}),/未达到/);
  assert.equal(calls,2);
  const rewrite=await writeStep({kind:'rewrite',input:'将这段改短。'},async()=> '晚安。');
  assert.deepEqual(rewrite,{text:'晚安。'});
});

test('streamed short drafts decode JSON escapes and reject a truncated final answer',async()=>{
  const {storyPreview,readCompletionStream}=await import('../server/writing-stream.mjs');
  const prefix='{"title":"月亮","text":"';
  assert.equal(storyPreview(prefix+'小兔\\n望向\\u67'),'小兔\n望向');
  assert.equal(storyPreview(prefix+'小兔\\n望向\\u6708"}'),'小兔\n望向月');
  const event=JSON.stringify({choices:[{delta:{content:'月亮',reasoning_content:'ignored'},finish_reason:'stop'}]});
  const raw=new TextEncoder().encode('data: '+event+'\r\n\r\ndata: [DONE]\r\n\r\n');
  let offset=0;
  const response=new Response(new ReadableStream({pull(c){
    if(offset<raw.length)c.enqueue(raw.slice(offset,++offset));else c.close();
  }}));
  assert.equal(await readCompletionStream(response,async()=>{}),'月亮');
  await assert.rejects(readCompletionStream(new Response('data: '+event+'\n\n'),async()=>{}),/未返回完整故事/);
});

test('an explicitly unsupported streaming option falls back to a normal short story',async()=>{
  const requests=[];
  const result=await writeStory({kind:'write',provider:'openai',input:'小兔',model:'fixture'},'fixture',async(_url,request)=>{
    const body=JSON.parse(request.body);requests.push(body.stream);
    if(body.stream)return Response.json({error:{message:'stream is not supported'}},{status:400});
    return Response.json({choices:[{finish_reason:'stop',message:{content:'{"title":"雨天","text":"小兔听见了雨声。"}'}}]});
  },null,async()=>{});
  assert.deepEqual(requests,[true,undefined]);
  assert.equal(result.text,'小兔听见了雨声。');
});
