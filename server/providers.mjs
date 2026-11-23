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
async function synthesize(provider,key,style,text,append,connect){
  const preset=voiceStyles[style],isOpenAI=provider==='openai';
  const url=isOpenAI?'https://api.openai.com/v1/realtime?model='+realtime:'https://api.deepseek.com/v1/tools/tts?format=pcm&voice_id='+preset.deepseek;
  const res=await connect(url,{headers:{Upgrade:'websocket',Authorization:'Bearer '+key},redirect:'manual',signal:AbortSignal.timeout(20000)});
  const ws=res.webSocket;if(!ws)throw voiceFailure();
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
export async function narrate(job,key,connect=fetch){
  const audio=[];let size=44;
  const append=data=>{
    requireValue(size+data.byteLength<=job.reserve,413,'朗读超过可用空间，建议分成较短的章节。');
    audio.push(data);size+=data.byteLength;
  };
  for(const part of sections(job.input,job.provider==='openai'?340:4000)){
    await synthesize(job.provider,key,job.style,part,append,connect);
  }
  requireValue(size>44&&(size-44)%2===0,502,'配音返回的数据不完整。');
  return new Blob([wavHeader(size-44),...audio],{type:'audio/wav'});
}
export async function writeStory(job,key,connect=fetch){
  const url=job.provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://api.deepseek.com/chat/completions';
  const r=await connect(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(120000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:job.model,...(job.provider==='openai'?{max_completion_tokens:3000}:{max_tokens:3000,thinking:{type:'disabled'}}),messages:[{role:'system',content:job.kind==='rewrite'?'按照家长提供的修改要求润色儿童故事的这一段。只输出替换用的一个段落，保持人物、事实和人称一致，避免惊吓。':'为儿童写一篇约 400 字的温柔中文故事。只输出可直接朗读的正文。避免惊吓、暴力和私人联系方式。'},{role:'user',content:job.input}]})});
  requireValue(r.ok,502,'写作服务未完成，请检查模型和额度。');
  const answer=(await r.json()).choices?.[0];
  requireValue(answer?.finish_reason==='stop'&&typeof answer.message?.content==='string'&&answer.message.content.trim()&&answer.message.content.length<=16000,502,'写作服务未返回完整故事。');
  return answer.message.content.trim();
}
