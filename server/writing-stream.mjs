import {ApiError,requireValue} from './common.mjs';

const incomplete='写作服务未返回完整故事。';

// Short stories arrive as a JSON object. Decode only complete escapes in its
// text field, even when a provider splits a quoted string across events.
export function storyPreview(raw){
  const field=/^\s*(?:`{3}(?:json)?\s*)?\{\s*(?:"title"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"text"\s*:\s*"((?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*)/i.exec(raw);
  return field ? JSON.parse('"'+field[1]+'"').replace(/[\uD800-\uDBFF]$/u,'') : '';
}

export async function readCompletionStream(response,preview){
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',parts=[],content='',reason=null,done=false;
  function dispatch(){
    if(!parts.length)return;
    const data=parts.join('\n');parts=[];
    if(data==='[DONE]'){done=true;return;}
    const event=JSON.parse(data),choice=event.choices?.[0];
    if(event.error)throw new ApiError(502,incomplete);
    if(choice?.finish_reason)reason=choice.finish_reason;
    const delta=choice?.delta?.content;
    if(typeof delta==='string')content+=delta;
    requireValue(content.length<=16000,502,incomplete);
  }
  try{
    while(!done){
      const chunk=await reader.read();
      buffer+=decoder.decode(chunk.value,{stream:!chunk.done});
      let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
        if(!line)dispatch();
        else if(line.startsWith('data:'))parts.push(line.slice(5).replace(/^ /,''));
      }
      requireValue(buffer.length<131072 && parts.join('').length<131072,502,incomplete);
      if(content)await preview(content);
      if(chunk.done)break;
    }
    requireValue(done && reason==='stop' && content.trim(),502,incomplete);
    return content.trim();
  }finally{await reader.cancel().catch(()=>{});}
}
