import type {RuntimeToolAction} from './runtime.ts';

/** Only complete, natural runtime message blocks are eligible for the compact
 * live progress view. Control objects, partial JSON and fenced output stay in
 * runtime evidence and cannot masquerade as an AI acknowledgement. Human text
 * never passes through this projection. */
export function visibleRuntimeProgress(text:string):string|null {
  const value=text.trim();
  if(!value||/^[{["`]/.test(value))return null;
  if(/(?:"(?:schemaVersion|resultKey|coordinationPlan)"\s*:|task-complete-v1)/.test(value))return null;
  return value.slice(0,2000);
}

export interface RuntimeToolSummary {
  action:RuntimeToolAction;
  target:string;
  argumentsSummary:string;
}

export interface RuntimeToolSummaryOptions {
  cwd?:string;
  /** Explicit factual primary target(s); never model-authored narration. */
  target?:unknown;
  /** Explicit selected fields. Raw content/patch/diff fields must not be passed. */
  parameters?:Record<string,unknown>;
}

const TOOL_ACTION_RULES:Array<[RuntimeToolAction,RegExp]> = [
  ['command',/\b(?:bash|powershell|pwsh|shell|command|command execution|exec|terminal|run command|execute)\b/],
  ['edit',/\b(?:write|edit|multiedit|multi edit|notebookedit|notebook edit|apply patch|applypatch|file change|filechange|create file|delete file|move|rename)\b/],
  ['read',/\b(?:read|readfile|read file|open file|cat|view|notebookread|notebook read|fetch|web fetch)\b/],
  ['search',/\b(?:grep|glob|search|web search|find|query|list directory|list files|ls)\b/],
];

const SAFE_PARAMETER_KEYS = [
  'path','file_path','filePath','notebook_path','cwd',
  'url','uri','query','pattern','glob','type','output_mode','include',
  'command','timeout','timeout_ms','limit','offset','head_limit','max_results',
  'replace_all','server','tool','namespace',
] as const;
const PATH_PARAMETER_KEYS = new Set(['path','file_path','filePath','notebook_path','cwd']);

export function runtimeToolAction(toolName:string):RuntimeToolAction {
  const name=` ${toolName
    .replace(/([a-z0-9])([A-Z])/g,'$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,' ')
    .trim()} `;
  for(const [action,pattern] of TOOL_ACTION_RULES)if(pattern.test(name))return action;
  return 'other';
}

/**
 * One bounded line of factual tool-input text. This deliberately removes
 * common credentials and control characters before persistence or display.
 */
export function safeRuntimeToolText(value:unknown,maxLength=240):string {
  if(value==null)return '';
  let text:string;
  if(typeof value==='string')text=value;
  else if(typeof value==='number'||typeof value==='boolean')text=String(value);
  else try{text=JSON.stringify(value)??'';}catch{text='';}
  text=Array.from(text).map(char=>{
    const code=char.charCodeAt(0);
    return code<32||code===127?' ':char;
  }).join('')
    .replace(/([?&](?:access_token|refresh_token|api[_-]?key|token|key|secret|password|passwd|signature|sig)=)[^&\s#]+/gi,'$1[REDACTED]')
    .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)?\s*)[^\s,;]+/gi,'$1[REDACTED]')
    .replace(/(["'](?:api[_-]?key|access_token|refresh_token|token|secret|password|passwd)["']\s*:\s*)["'][^"']*["']/gi,'$1"[REDACTED]"')
    .replace(/\b((?:api[_-]?key|access_token|refresh_token|token|secret|password|passwd)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&|]+)/gi,'$1[REDACTED]')
    .replace(/((?:^|\s)--?(?:api[_-]?key|access_token|refresh_token|token|secret|password|passwd)\s+)(?:"[^"]*"|'[^']*'|[^\s,;&|]+)/gi,'$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,'[REDACTED]')
    .replace(/\s+/g,' ')
    .trim();
  const bound=Math.max(24,Math.floor(maxLength));
  return text.length<=bound?text:`${text.slice(0,bound-1)}…`;
}

/** Workspace-relative target display; outside absolute paths retain only basename. */
export function safeRuntimeToolTarget(value:unknown,cwd?:string,maxLength=200):string {
  let text=safeRuntimeToolText(value,Math.max(200,(maxLength*3)));
  if(text.length===0)return '';
  const normalized=text.replaceAll('\\','/').replace(/\/+/g,'/');
  const root=cwd?.replaceAll('\\','/').replace(/\/+/g,'/').replace(/\/$/,'')??'';
  if(root.length>0){
    const lower=normalized.toLowerCase();const rootLower=root.toLowerCase();
    if(lower===rootLower)text='.';
    else if(lower.startsWith(`${rootLower}/`))text=normalized.slice(root.length+1);
  }
  if(/^(?:[A-Za-z]:\/|\/\/|\/)/.test(text.replaceAll('\\','/')))
    text=text.replaceAll('\\','/').split('/').filter(Boolean).at(-1)??text;
  return safeRuntimeToolText(text,maxLength);
}

/** Normalize factual tool input into the shared activity contract. */
export function runtimeToolSummary(
  toolName:string,
  input:unknown,
  options:RuntimeToolSummaryOptions={},
):RuntimeToolSummary {
  const action=runtimeToolAction(toolName);
  const record=isRecord(input)?input:{};
  const parameters:Record<string,unknown>={};
  if(options.parameters!=null){
    for(const [key,value] of Object.entries(options.parameters))
      parameters[key]=safeParameter(key,value,options.cwd);
  }else{
    if(Array.isArray(record['changes'])){
      const changes=record['changes'].filter(isRecord);
      parameters['files']=changes.slice(0,16).flatMap(change=>{
        const path=change['path'];
        if(path==null)return [];
        const safePath=safeRuntimeToolTarget(path,options.cwd);
        const kind=typeof change['kind']==='string'?safeRuntimeToolText(change['kind'],24):'';
        return [kind.length>0?`${safePath} (${kind})`:safePath];
      });
      if(changes.length>16)parameters['moreFiles']=changes.length-16;
    }
    if(Array.isArray(record['edits']))parameters['editCount']=record['edits'].length;
    for(const key of SAFE_PARAMETER_KEYS){
      if(record[key]==null||parameters[key]!=null)continue;
      parameters[key]=safeParameter(key,record[key],options.cwd);
    }
    if(Object.keys(parameters).length===0&&typeof input==='string'&&input.trim().length>0)
      parameters['detail']=safeRuntimeToolText(input,160);
  }

  const targetParts=collectTargetParts(toolName,action,record,options.cwd,options.target);
  return {
    action,
    target:safeRuntimeToolText(targetParts.length>0?targetParts.join(' · '):toolName,200),
    argumentsSummary:safeRuntimeToolText(JSON.stringify(parameters),480),
  };
}

/** Short factual failure detail from an actual tool result; success bodies are not copied. */
export function runtimeToolResultSummary(value:unknown,maxLength=240):string {
  return safeRuntimeToolText(resultText(value),maxLength);
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return typeof value==='object'&&value!=null&&!Array.isArray(value);
}

function safeParameter(key:string,value:unknown,cwd?:string):unknown {
  if(value==null)return undefined;
  if(PATH_PARAMETER_KEYS.has(key))return safeRuntimeToolTarget(value,cwd);
  if(typeof value==='number'||typeof value==='boolean')return value;
  if(Array.isArray(value))return value.slice(0,8).map(item=>safeRuntimeToolText(item,120));
  return safeRuntimeToolText(value,key==='command'?220:160);
}

function collectTargetParts(
  toolName:string,
  action:RuntimeToolAction,
  record:Record<string,unknown>,
  cwd:string|undefined,
  explicit:unknown,
):string[] {
  const values:Array<{value:unknown;path?:boolean}>=[];
  const add=(value:unknown,path=false)=>{if(value!=null)values.push({value,path});};
  if(explicit!=null){
    if(Array.isArray(explicit))for(const value of explicit)add(value,typeof value==='string');
    else add(explicit,typeof explicit==='string');
  }
  if(Array.isArray(record['changes']))
    for(const change of record['changes'].filter(isRecord))add(change['path'],true);
  if(action==='command')add(record['command']);
  if(action==='search'){
    add(record['pattern']);add(record['query']);
    add(record['path'],true);add(record['glob']);
  }else if(action==='read'){
    add(record['file_path'],true);add(record['path'],true);add(record['url']);add(record['uri']);
  }else if(action==='edit'){
    add(record['file_path'],true);add(record['path'],true);add(record['notebook_path'],true);
  }else{
    add(record['url']);add(record['uri']);add(record['query']);add(record['pattern']);
    add(record['file_path'],true);add(record['path'],true);add(record['tool']);
  }
  if(values.length===0&&typeof record['input']==='string')add(record['input']);
  const seen=new Set<string>();
  const parts:string[]=[];
  for(const item of values){
    const text=item.path
      ?safeRuntimeToolTarget(item.value,cwd,160)
      :safeRuntimeToolText(item.value,180);
    if(text.length===0||seen.has(text))continue;
    seen.add(text);parts.push(text);
  }
  if(parts.length===0)parts.push(toolName);
  return parts;
}

function resultText(value:unknown,depth=0):string {
  if(depth>3||value==null)return '';
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(item=>resultText(item,depth+1)).filter(Boolean).join(' ');
  if(!isRecord(value))return '';
  for(const key of ['message','error','stderr','stdout','text','content','reason','detail'])if(value[key]!=null){
    const text=resultText(value[key],depth+1);
    if(text.length>0)return text;
  }
  return '';
}

export interface ThreadVisibleProgress {
  turnId:string;memberId:string;status:string;text:string|null;updatedAt:number|null;
  phase:'connecting'|'connected'|'responding';
  runId:string;
  stage:string|null;
  waitStartedAt:number|null;
  /** Start of this exact turn; resets for every new turn. */
  executionStartedAt:number|null;
  /** Latest persisted message/progress/tool event, never a synthetic heartbeat. */
  lastActivityAt:number|null;
  activities:RuntimeActivityFact[];
}

export interface RuntimeActivityFact {
  toolCallId:string;
  toolName:string|null;
  action:'read'|'search'|'command'|'edit'|'other';
  target:string;
  status:'started'|'success'|'failure'|'unknown';
  startedAt:number|null;
  completedAt:number|null;
  resultSummary:string|null;
}

function waitedText(waitStartedAt:number|null, now:number):string {
  if(waitStartedAt==null)return '';
  const seconds=Math.max(0,Math.floor((now-waitStartedAt)/1000));
  if(seconds<60)return ` · 已等待 ${seconds} 秒`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return ` · 已等待 ${minutes} 分钟 ${seconds%60} 秒`;
  const hours=Math.floor(minutes/60);
  return ` · 已等待 ${hours} 小时 ${minutes%60} 分钟 ${seconds%60} 秒`;
}

/** One factual status line for the live progress card. Waiting object comes
 * from persisted turn/run state, never from transport connection alone. */
export function runtimeProgressWaitLabel(progress:Pick<ThreadVisibleProgress,'status'|'phase'|'waitStartedAt'>&Partial<Pick<ThreadVisibleProgress,'executionStartedAt'>>,now=Date.now()):string {
  if(progress.status==='STOPPING')return '正在停止';
  if(progress.status==='WAITING_APPROVAL')return `等待你确认操作${waitedText(progress.waitStartedAt,now)}`;
  if(progress.status==='WAITING_INPUT')return `等待你补充信息${waitedText(progress.waitStartedAt,now)}`;
  if(progress.status==='PENDING'||progress.status==='DISPATCHING')return `等待执行席位${waitedText(progress.waitStartedAt,now)}`;
  if(progress.executionStartedAt===null)return '准备执行';
  if(progress.phase==='connecting')return `正在连接模型${waitedText(progress.waitStartedAt,now)}`;
  if(progress.phase==='connected')return `等待模型回应${waitedText(progress.waitStartedAt,now)}`;
  return '正在返回内容';
}
