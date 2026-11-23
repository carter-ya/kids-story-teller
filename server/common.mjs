export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, status, message) {
  if (!condition) throw new ApiError(status, message);
}
export function json(data, status = 200, headers = {}) {
  return Response.json(data, {status, headers:{'Cache-Control':'no-store', ...headers}});
}
export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function readJson(request, max = 65536) {
  requireValue(request.headers.get('content-type')?.startsWith('application/json'),415,'需要 JSON 请求。');
  const reader=request.body?.getReader();requireValue(reader,400,'请求缺少正文。');
  const chunks=[];let length=0;
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    length+=value.length;
    if(length>max){await reader.cancel();throw new ApiError(413,'请求超过大小限制。');}
    chunks.push(value);
  }
  try{const value=JSON.parse(await new Blob(chunks).text());requireValue(value && typeof value==='object' && !Array.isArray(value),400,'无效的数据。');return value;}
  catch{throw new ApiError(400,'无效的 JSON。');}
}
export const providers = ['openai','deepseek'];
export function validProvider(name){requireValue(providers.includes(name),400,'请选择已支持的服务商。');}
export function admin(session){requireValue(session && session.kid===null,403,'此操作需要家长身份。');}
