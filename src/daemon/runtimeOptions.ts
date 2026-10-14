import {execFile} from 'node:child_process';
import {resolveClaudeExecutable} from '../adapter/claude/cliAdapter.ts';
import {CodexAppServerAdapter} from '../adapter/codex/appServerAdapter.ts';

/** Bounded local discovery; never creates a provider thread or inference turn. */
export function claudeEffortsFromHelp(help:string) {
  const lines=help.split('\n'),index=lines.findIndex(line=>/--effort\s/.test(line));
  if(index<0)return [];
  const block=[lines[index]!];
  for(let n=index+1;n<lines.length&&!/^\s*--/.test(lines[n]!);n++)block.push(lines[n]!);
  return ['low','medium','high','xhigh','max'].filter(level=>new RegExp(`\\b${level}\\b`).test(block.join(' ')));
}
export async function runtimeOptions(kind:string,executable:string|undefined,model:string|undefined,cwd:string) {
  if(kind==='claude') {
    const entry=resolveClaudeExecutable(executable);
    const help=await new Promise<string>((resolve,reject)=>execFile(entry.command,[...entry.prefixArgs,'--help'],{cwd,windowsHide:true,timeout:10000,maxBuffer:256*1024},(error,out)=>error?reject(Error('无法读取 Claude CLI 选项，请检查程序引用')):resolve(out)));
    const efforts=claudeEffortsFromHelp(help);
    return {efforts,source:'本机 Claude CLI --help',reason:efforts.length?'参数会实际传给 CLI；第三方渠道是否采用以真实结果为准':'当前 CLI 没有声明可用思考等级',imageInput:'automatic'};
  }
  if(kind==='codex') {
    const adapter=new CodexAppServerAdapter({executable,cwd,requestTimeoutMs:10000});
    try{const models=await adapter.listModels();const selected=models.find(m=>m.model===model||m.id===model);return {efforts:selected?.supportedReasoningEfforts?.map(e=>e.reasoningEffort)??[],defaultEffort:selected?.defaultReasoningEffort,models,source:'正式 app-server model/list（无模型调用）',reason:selected?'按当前模型声明提供等级':'未在当前 model/list 找到模型 ID',imageInput:selected?.inputModalities?selected.inputModalities.includes('image')?'supported':'unsupported':'automatic'};}finally{await adapter.dispose();}
  }
  return {efforts:[],source:'无真实 CLI',reason:'工程运行时没有真实思考等级',imageInput:'unsupported'};
}
