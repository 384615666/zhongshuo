import {resolveClaudeConfiguration} from '../adapter/claude/configuration.ts';
import {runtimeOptions} from './runtimeOptions.ts';
import {memberExecutableStatus} from './memberManagement.ts';

export interface RuntimeCatalog {
  kind:string;models:Array<{id:string;label:string;source:'reported'|'configured'}>;
  defaultModel:string|null;source:string;warning:string|null;truncated:boolean;
  program:{status:'found'|'missing'|'unknown';reason:string};
}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$/.test(value)&&!value.startsWith('sk-');
/** Only metadata from the explicitly configured channel. No inference, thread,
 * prompt, project bytes or external fallback service. Never forwards redirects. */
export async function claudeModelCatalog(cwd:string):Promise<Omit<RuntimeCatalog,'kind'|'program'>>{
  const config=resolveClaudeConfiguration(cwd);
  const env=config.restrictedEnv;
  const configured=[process.env.ZS_CLAUDE_MODEL,env.ANTHROPIC_MODEL,config.configuredModel,env.ANTHROPIC_DEFAULT_SONNET_MODEL,env.ANTHROPIC_DEFAULT_OPUS_MODEL,env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter(validId);
  const models:RuntimeCatalog['models']=[...new Set(configured)].map(id=>({id,label:id,source:'configured'}));
  const fallback=(warning:string)=>({models,defaultModel:configured[0]??null,source:'当前 CLI 配置',warning,truncated:false});
  if(config.reason)return fallback('有效渠道尚不能确定，未向候选渠道请求模型列表；可保留已有配置。');
  const token=env.ANTHROPIC_AUTH_TOKEN,key=env.ANTHROPIC_API_KEY;
  if(!token&&!key)return fallback('当前凭据由 CLI 登录管理，未读取登录凭据；渠道未提供可查询的模型列表。');
  const url=new URL(config.channel);url.pathname=url.pathname.replace(/\/$/,'').replace(/\/v1$/,'')+'/v1/models';
  try{
    const response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'anthropic-version':'2023-06-01',...(token?{Authorization:`Bearer ${token}`}:{'x-api-key':key!})}});
    if(!response.ok)return fallback(`渠道模型列表读取失败（HTTP ${response.status}）；已保留本机配置，不代表模型不可用。`);
    if(Number(response.headers.get('content-length')??0)>524288)return fallback('渠道模型列表超出读取上限，未采用部分响应。');
    const reader=response.body?.getReader();if(!reader)return fallback('渠道没有返回模型列表。');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>524288){await reader.cancel();return fallback('渠道模型列表超出读取上限，未采用部分响应。');}chunks.push(part.value);}}finally{reader.releaseLock();}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {data?:Array<{id?:unknown;display_name?:unknown;name?:unknown}>;has_more?:boolean;nextCursor?:unknown};
    if(!Array.isArray(body.data))return fallback('渠道返回格式未识别；保留本机配置，可在高级设置指定模型。');
    const reported=body.data.slice(0,500).flatMap(row=>{
      if(!validId(row.id))return[];
      const raw=row.display_name??row.name;
      const label=typeof raw==='string'&&raw.length<=120&&!/[\r\n\0]/.test(raw)&&!raw.includes('sk-')?raw:row.id;
      return[{id:row.id,label,source:'reported' as const}];
    });
    const unique=new Map(models.map(m=>[m.id,m]));for(const model of reported)unique.set(model.id,model);
    return{models:[...unique.values()].slice(0,500),defaultModel:configured[0]??null,source:'当前渠道模型列表 + 本机配置',warning:null,truncated:Boolean(body.has_more||body.nextCursor||body.data.length>500||unique.size>500)};
  }catch{return fallback('渠道模型列表暂时不可读；保留本机配置，可重试读取或在高级设置指定模型。');}
}
export async function runtimeCatalog(kind:'claude'|'codex'|'fake',executable:string|undefined,cwd:string):Promise<RuntimeCatalog>{
  const program=memberExecutableStatus(kind,executable??kind);
  if(kind==='claude')return{kind,program,...await claudeModelCatalog(cwd)};
  if(kind==='codex'){
    const options=await runtimeOptions(kind,executable,undefined,cwd);
    const models='models' in options?options.models??[]:[];
    return{kind,program,models:models.filter(m=>validId(m.model??m.id)).map(m=>({id:m.model??m.id,label:m.displayName??m.model??m.id,source:'reported' as const})),defaultModel:process.env.ZS_E2E_MODEL??null,source:'本机 Codex model/list',warning:null,truncated:false};
  }
  return{kind,program,models:[],defaultModel:null,source:'工程夹具',warning:'仅工程环境使用，不是真实模型。',truncated:false};
}
