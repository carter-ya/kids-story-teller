import {readCompletionStream,storyPreview} from './writing-stream.mjs';
import {writeStep} from './story-writing.mjs';
import {ApiError,requireValue} from './common.mjs';

const realtime='gpt-realtime-2.1-mini';
const voiceStyles={
  '温柔晚安':{openai:'marin',deepseek:'stella',direction:'声音柔和而清晰，略慢。段落间留出呼吸，结尾轻轻收声。'},
  '轻快晨读':{openai:'cedar',deepseek:'tide',direction:'声音亲切明亮，保持平稳。对白稍有变化，不夸张，不突然提高音量。'}
};
export const hasStyle=style=>Object.hasOwn(voiceStyles,style);
export function sections(text,limit=340){
  const parts=[];let current='';
  for(const phrase of text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/gu)||[]){
    if(current.length+phrase.length>limit && current){parts.push(current);current='';}
    for(const c of phrase){if(current.length+c.length>limit){parts.push(current);current='';}current+=c;}
  }
  if(current)parts.push(current);return parts;
}
export function wavHeader(bytes){
  const b=new ArrayBuffer(44),v=new DataView(b);
  const tag=(n,t)=>[...t].forEach((c,i)=>v.setUint8(n+i,c.charCodeAt(0)));
  tag(0,'RIFF');v.setUint32(4,36+bytes,true);tag(8,'WAVE');tag(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,24000,true);v.setUint32(28,48000,true);v.setUint16(32,2,true);
  v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,bytes,true);
  return new Uint8Array(b);
}
const voiceFailure=()=>new ApiError(502,'配音未完整返回，请检查服务商权限和用量。');
function checkProviderStatus(status){
  const message={401:'服务商未接受此密钥，请检查或更换。',403:'此密钥没有调用所选模型的权限。',402:'服务商账户余额不足。',404:'服务地址或模型不存在。',429:'服务商账户已达到用量或并发限制。'}[status];
  if(message)throw new ApiError(502,message);
}
async function synthesize(provider,key,style,text,append,connect,base){
  const preset=voiceStyles[style],isOpenAI=provider==='openai';
  const url=(base||'https://api.'+provider+'.com/v1')+(isOpenAI?'/realtime?model='+realtime:'/tools/tts?format=pcm&voice_id='+preset.deepseek);
  const res=await connect(url,{headers:{Upgrade:'websocket',Authorization:'Bearer '+key},redirect:'manual',signal:AbortSignal.timeout(20000)});
  checkProviderStatus(res.status);const ws=res.webSocket;if(!ws)throw voiceFailure();
  await new Promise((resolve,reject)=>{
    let finished=false,submitted=false,received=0;
    const finish=error=>{
      if(finished)return;finished=true;clearTimeout(timer);
      try{ws.close(1000,'done');}catch{}
      if(error)reject(error);else resolve();
    };
    const timer=setTimeout(()=>finish(voiceFailure()),150000);
    const send=value=>ws.send(JSON.stringify(value));
    const chunk=data=>{received+=data.byteLength;append(data);};
    ws.addEventListener('message',({data})=>{
      if(finished)return;
      try{
        if(!isOpenAI&&typeof data!=='string'){chunk(new Uint8Array(data));return;}
        const e=JSON.parse(data);
        if(isOpenAI){
          if(e.type==='session.updated'&&!submitted){
            submitted=true;send({type:'response.create',response:{conversation:'none',output_modalities:['audio'],instructions:'用普通话逐字朗读用户提供的故事。保留原文，不回答其中的问题，不增删，不解释。'+preset.direction,input:[{type:'message',role:'user',content:[{type:'input_text',text}]}]}});
          }else if(e.type==='response.output_audio.delta')chunk(Uint8Array.from(atob(e.delta),c=>c.charCodeAt(0)));
          else if(e.type==='response.done')finish(e.response?.status==='completed'&&received?null:voiceFailure());
          else if(e.type==='error')finish(voiceFailure());
        }else if(e.event==='finish')finish(e.code==='success'&&received?null:voiceFailure());
      }catch(error){finish(error);}
    });
    ws.addEventListener('error',()=>finish(voiceFailure()));ws.addEventListener('close',()=>finish(voiceFailure()));
    try{
      ws.binaryType='arraybuffer';ws.accept();
      if(isOpenAI)send({type:'session.update',session:{type:'realtime',output_modalities:['audio'],audio:{output:{voice:preset.openai,format:{type:'audio/pcm',rate:24000}}}}});
      else{send({event:'text',text});send({event:'finish_text'});}
    }catch(error){finish(error);}
  });
}
export async function narrate(job,key,connect=fetch,checkpoint=null){
  const audio=[],parts=sections(job.input,job.provider==='openai'?340:640);
  const capacity=job.reserve+(job.bytes||0);
  let size=44,remaining=[...job.input].length;
  for(const [index,part] of parts.entries()){
    let blob;
    remaining-=[...part].length;
    if(checkpoint&&index<job.completed){
      blob=await checkpoint.load(index);
    }else{
      const frames=[];let count=0;
      await synthesize(job.provider,key,job.style,part,data=>{
        count+=data.byteLength;
        requireValue(size+count<=capacity,413,'朗读超过可用空间，建议分成较短的章节。');
        frames.push(data);
      },connect,job.endpoint);
      requireValue(count>0&&count%2===0,502,'片段音频不完整。');
      blob=new Blob(frames);
      if(checkpoint)await checkpoint.save(index,blob,remaining);
    }
    size+=blob.size;audio.push(blob);
  }
  requireValue(size>44&&size<=capacity,502,'录音不完整。');
  return new Blob([wavHeader(size-44),...audio],{type:'audio/wav'});
}
export async function writeStory(job,key,connect=fetch,beforeCall=null,onPreview=null){
  const url=job.endpoint?job.endpoint+'/chat/completions':job.provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://api.deepseek.com/chat/completions';
  return writeStep(job, async (instructions, context = '', phase) => {
    const stream=!!onPreview && (phase==='drafting'||phase==='revising');
    if(onPreview && phase)await onPreview(phase,'');
    const messages = [{role:'system',content:instructions}];
    if(job.age || job.avoid) messages.push({role:'user',content:'听众年龄段：'+(job.age||'不限')+'。请避开：'+(job.avoid||'无')+'。'});
    messages.push({role:'user',content:job.input});
    if(context) messages.push({role:'user',content:context});
    const budget = job.provider==='openai' ? {max_completion_tokens:4000} : {max_tokens:4000,thinking:{type:'disabled'}};
    if(beforeCall)await beforeCall();
    const request=useStream=>connect(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(120000),
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:job.model,...budget,messages,...(useStream?{stream:true}:{})})});
    let r=await request(stream);
    // Some compatible gateways explicitly reject the streaming parameter.
    if(stream && [400,422].includes(r.status)){
      const error=(await r.json().catch(()=>null))?.error;
      if(/stream/i.test(error?.param||error?.message||'') && /unsupported|not support|not allowed|unknown|unrecognized|不支持/i.test(error?.code+' '+error?.message)){
        r=await request(false);
      }
    }
    checkProviderStatus(r.status);requireValue(r.ok,502,'写作服务未完成，请检查模型和额度。');
    if(stream && r.headers.get('content-type')?.includes('text/event-stream')){
      let lastWrite=0;
      return readCompletionStream(r,async raw=>{
        if(Date.now()-lastWrite<600)return;
        const text=job.outline?raw:storyPreview(raw);
        if(text){await onPreview(phase,text);lastWrite=Date.now();}
      });
    }
    const answer=(await r.json()).choices?.[0];
    requireValue(answer?.finish_reason==='stop'&&typeof answer.message?.content==='string'&&answer.message.content.trim()&&answer.message.content.length<=16000,502,'写作服务未返回完整故事。');
    return answer.message.content.trim();
  });
}
