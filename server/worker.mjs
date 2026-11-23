import {ApiError,json,requireValue} from './common.mjs';
import {apiSession,apiShelf,credentials,sessionFor,collectShelves} from './family.mjs';

export default {
  async fetch(req,env){
    const {origin,pathname:path}=new URL(req.url);
    if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
    try{
      if(!['GET','HEAD'].includes(req.method))requireValue(req.headers.get('Origin')===origin,403,'此操作需要从当前站点发起。');
      const session=await sessionFor(req,env);
      if(path.startsWith('/api/session')){
        const response=await apiSession(req,env,path,session);if(response)return response;
      }
      requireValue(session,401,'请先登录云端家庭。');
      if(path==='/api/library')return await apiShelf(req,env,session);
      const credential=/^\/api\/credentials\/(openai|deepseek)$/.exec(path);
      if(credential)return await credentials(req,env,session,credential[1]);
      return json({error:'找不到接口。'},404);
    }catch(error){return json({error:error instanceof ApiError?error.message:'暂时无法完成操作。'},error instanceof ApiError?error.status:500);}
  },
  async scheduled(_,env){await collectShelves(env);}
};
