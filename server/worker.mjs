import {configs} from './configs.mjs';
import {accounts} from './accounts.mjs';
import {submit,generation,runJob,maintainJobs} from './generation.mjs';
import {ApiError,json,requireValue} from './common.mjs';
import {apiSession,apiShelf,credentials,sessionFor,collectShelves} from './family.mjs';

export default {
  async fetch(req,env){
    const {origin,pathname:path}=new URL(req.url);
    if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
    try{
      if(!['GET','HEAD'].includes(req.method))requireValue(req.headers.get('Origin')===origin,403,'此操作需要从当前站点发起。');
      const session=await sessionFor(req,env);
      const expected=req.headers.get('X-Story-Family');
      if(expected)requireValue(session?.family===expected,409,'家庭登录状态已变化，请刷新页面。');
      if(path.startsWith('/api/session')){
        const response=await apiSession(req,env,path,session);if(response)return response;
      }
      requireValue(session,401,'请先登录云端家庭。');
      const account=/^\/api\/accounts(?:\/([\w-]+))?$/.exec(path);
      if(account)return await accounts(req,env,session,account[1]);
      if(path==='/api/library')return await apiShelf(req,env,session);
      if(path==='/api/generation')return await submit(req,env,session);
      const job=/^\/api\/(generation|audio)\/([a-zA-Z0-9-]{12,64})$/.exec(path);
      if(job)return await generation(req,env,session,job[2],job[1]==='audio');
      const config=/^\/api\/configs(?:\/([\w-]+))?$/.exec(path);
      if(config)return await configs(req,env,session,config[1]);
      const credential=/^\/api\/credentials\/(openai|deepseek)$/.exec(path);
      if(credential)return await credentials(req,env,session,credential[1]);
      return json({error:'找不到接口。'},404);
    }catch(error){return json({error:error instanceof ApiError?error.message:'暂时无法完成操作。'},error instanceof ApiError?error.status:500);}
  },
  async queue(batch,env){for(const message of batch.messages){await runJob(env,message.body);message.ack();}},
  async scheduled(_,env){await collectShelves(env);await maintainJobs(env);}
};
