import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type { OpenSessionInput, ProbeResult, RuntimeCapabilities, SessionRef, TurnRequest } from '../../contracts/runtime.ts';
import { externalRuntimeLaunchIdentity } from '../cli/configuration.ts';
import { resolveAgentExecutable } from '../cli/executable.ts';
import { CliTurnAdapter, isRecord, type CliAdapterOptions, type CliSession, type CliTurn } from '../cli/turnAdapter.ts';
import type { ExternalModel } from '../deepseekHarness/adapter.ts';

export const PI_ADAPTER_VERSION = 'pi-rpc-adapter-1';
export function piCapabilities(): RuntimeCapabilities {
  return { structuredEvents:'unverified',taskContextIsolation:'unverified',resumeSession:'unverified',steerActiveTurn:'unsupported',
    interrupt:'unverified',interactiveApprovals:'unsupported',structuredFinal:'unverified',restrictWrites:'unsupported',
    restrictShell:'unsupported',disableDelegation:'unsupported',usageTokens:'unverified',usageCost:'unverified' };
}
export interface PiAdapterOptions extends CliAdapterOptions { sessionDir?: string }
interface PiSessionData { id: string; dir: string; file: string | null; systemFile: string | null }
const samePath = (a:string,b:string) => process.platform==='win32'?normalize(resolve(a)).toLowerCase()===normalize(resolve(b)).toLowerCase():resolve(a)===resolve(b);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const META_ARGS = ['--mode','rpc','--no-session','--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-approve'];

export class PiAdapter extends CliTurnAdapter {
  private readonly metadata = new Map<string,PiSessionData>();
  private readonly piOptions:PiAdapterOptions;
  constructor(options:PiAdapterOptions={}) {super('pi',PI_ADAPTER_VERSION,options);this.piOptions=options;}
  capabilities():RuntimeCapabilities{return piCapabilities();}
  override async openSession(input:OpenSessionInput):Promise<SessionRef>{
    const ref=await super.openSession(input);
    const id=input.resume?.providerSessionId??randomUUID();
    if(!uuid.test(id))throw new AdapterCallError('VALIDATION_INVALID','Pi 会话编号不属于众说创建的独立会话',true);
    const base=this.piOptions.sessionDir??join(process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'),'sessions','zhongshuo',createHash('sha256').update(realpathSync.native(input.cwd)).digest('hex').slice(0,24));
    this.metadata.set(ref.id,{id,dir:resolve(base),file:null,systemFile:null});return ref;
  }
  protected arguments(session:CliSession):string[]{
    const meta=this.meta(session.ref);mkdirSync(meta.dir,{recursive:true});
    const args=['--mode','rpc','--offline','--session-dir',meta.dir,'--session-id',meta.id];
    if(this.options.model){
      const slash=this.options.model.indexOf('/');
      if(slash>0)args.push('--provider',this.options.model.slice(0,slash),'--model',this.options.model.slice(slash+1));
      else args.push('--model',this.options.model);
    }
    if(this.options.effort)args.push('--thinking',this.options.effort==='none'?'off':this.options.effort);
    if(session.input.developerInstructions){
      if(!meta.systemFile){const dir=mkdtempSync(join(tmpdir(),'zs-pi-instructions-'));meta.systemFile=join(dir,'instructions.md');writeFileSync(meta.systemFile,session.input.developerInstructions,{encoding:'utf8',mode:0o600,flag:'wx'});}
      args.push('--append-system-prompt',meta.systemFile);
    }
    return args;
  }
  protected validate(session:CliSession,input:TurnRequest):void{
    if(!session.input.writeAccess?.fullAccess||session.input.writeAccess.analysisOnly||input.repairOnly||![undefined,'bypassPermissions'].includes(this.options.permissionMode))
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED','Pi 当前支持原生完整权限；只读分析、项目受限编辑和格式修复尚未认证',true);
    if(input.images?.length)throw new AdapterCallError('CAPABILITY_UNSUPPORTED','Pi 图片输入尚未认证，请换用已支持图片的成员',true);
    if(this.options.model&&!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(this.options.model))throw new AdapterCallError('VALIDATION_INVALID','Pi 模型编号无效',true);
    if(this.options.effort&&!['off','none','minimal','low','medium','high','xhigh'].includes(this.options.effort))throw new AdapterCallError('VALIDATION_INVALID','Pi 思考等级无效',true);
    const expected=session.input.writeAccess.launchConfigurationKey;
    if(expected&&externalRuntimeLaunchIdentity('pi',this.options,session.ref.cwd).identityKey!==expected)throw new AdapterCallError('STALE_EXECUTION','Pi 程序或配置已变化，请重新发送',true);
    if(session.requestedSessionId){
      const meta=this.meta(session.ref);
      const candidates=existsSync(meta.dir)?readdirSync(meta.dir).filter(name=>name.endsWith(`_${meta.id}.jsonl`)||name===`${meta.id}.jsonl`):[];
      if(candidates.length!==1)throw new AdapterCallError('RESOURCE_NOT_FOUND','Pi 原会话不存在或编号有歧义；没有创建替代会话',true);
      const path=join(meta.dir,candidates[0]!);const fd=openSync(path,'r');const buffer=Buffer.alloc(65536);let header:unknown;
      try{const size=readSync(fd,buffer,0,buffer.length,0);header=JSON.parse(buffer.subarray(0,size).toString('utf8').split('\n')[0]!);}finally{closeSync(fd);}
      if(!isRecord(header)||header.type!=='session'||header.id!==meta.id||typeof header.cwd!=='string'||!samePath(realpathSync.native(header.cwd),realpathSync.native(session.ref.cwd)))
        throw new AdapterCallError('THREAD_SCOPE_MISMATCH','Pi 会话文件的目录或编号与当前任务不符',true);
      meta.file=path;
    }
  }
  protected begin(session:CliSession,turn:CliTurn):void{
    this.send(turn,{id:`${turn.requestId}:state`,type:'get_state'});
    this.timer(turn,()=>{if(!turn.ready&&!turn.terminal)this.protocolFailure(session,turn,'Pi 未完成会话握手，请检查 CLI 版本和配置');},this.options.requestTimeoutMs??10000);
  }
  protected cancel(_session:CliSession,turn:CliTurn):void{this.send(turn,{id:`${turn.requestId}:abort`,type:'abort'});}
  /** Pi 1.4.0 / Node 24 on Windows can assert when EOF races native tool
   * cleanup. Keep tracking the real child while allowing its callbacks to drain. */
  protected override stdinCloseDelayMs(turn:CliTurn):number{return process.platform==='win32'&&turn.tools.size>0?300:0;}
  protected onFrame(session:CliSession,turn:CliTurn,frame:Record<string,unknown>):void{
    if(typeof frame.type!=='string')throw Error('Pi 消息缺少类型');
    if(frame.type==='response'){
      if(typeof frame.id!=='string'||!frame.id.startsWith(`${turn.requestId}:`))throw Error('Pi 命令响应不属于当前请求');
      const suffix=frame.id.slice(turn.requestId.length+1);
      if(!['state','prompt','abort'].includes(suffix)||frame.command!==({state:'get_state',prompt:'prompt',abort:'abort'} as Record<string,string>)[suffix])throw Error('Pi 响应命令不匹配');
      if(frame.success!==true){this.fail(session,turn,'PROVIDER_ERROR',typeof frame.error==='string'?frame.error:'Pi 拒绝了本轮请求',true);return;}
      if(suffix==='state'){
        if(turn.ready||!isRecord(frame.data))throw Error('Pi 会话信息无效');
        const data=frame.data,meta=this.meta(session.ref);
        if(data.sessionId!==meta.id||typeof data.sessionFile!=='string'||!isAbsolute(data.sessionFile)||!samePath(dirname(data.sessionFile),meta.dir)||data.isStreaming===true||data.pendingMessageCount!==0)
          throw Error('Pi 返回了不同或仍在运行的会话');
        if(meta.file&&!samePath(data.sessionFile,meta.file))throw Error('Pi 续接了另一份会话文件');
        meta.file=data.sessionFile;this.sessionReady(session,turn,data.sessionId);turn.ready=true;
        if(turn.stopRequested){this.fail(session,turn,'INTERRUPTED','Pi 在启动阶段收到停止请求');return;}
        this.send(turn,{id:`${turn.requestId}:prompt`,type:'prompt',message:turn.input.text});return;
      }
      if(suffix==='prompt'){
        if(isRecord(frame.data)&&frame.data.disposition==='handled')this.fail(session,turn,'CAPABILITY_UNSUPPORTED','Pi 扩展处理了输入，没有启动可跟踪的任务',true);
      }
      return; // An acknowledgement never settles model execution.
    }
    if(frame.type==='extension_ui_request'){
      if(['notify','setStatus','setWidget','setTitle','set_editor_text'].includes(String(frame.method)))return;
      this.fail(session,turn,'CAPABILITY_UNSUPPORTED','Pi 扩展需要交互操作，众说尚未接入此对话框');this.cancel(session,turn);return;
    }
    if(!turn.ready)throw Error('Pi 在会话握手前返回了执行事件');
    switch(frame.type){
      case 'agent_start': this.started(session,turn);break;
      case 'message_update':{
        if(!isRecord(frame.assistantMessageEvent))throw Error('Pi 文本事件格式无效');const event=frame.assistantMessageEvent;
        if(event.type==='text_delta')this.text(session,turn,event.delta);
        else if(event.type==='thinking_delta')this.text(session,turn,event.delta,true);
        break;
      }
      case 'message_end':{
        if(!isRecord(frame.message)||frame.message.role!=='assistant')break;const message=frame.message;
        turn.values.set('lastAssistant',message);
        if(isRecord(message.usage)){
          const usage=message.usage;
          this.usage(session,turn,{inputTokens:usage.input,cachedTokens:usage.cacheRead,outputTokens:usage.output,
            model:typeof message.provider==='string'&&typeof message.model==='string'?`${message.provider}/${message.model}`:message.model,
            ...(isRecord(usage.cost)?{cost:usage.cost.total,costQuality:'estimated'}:{})});
        }
        break;
      }
      case 'tool_execution_start':this.toolStart(session,turn,frame.toolCallId,frame.toolName,frame.args);break;
      case 'tool_execution_end':this.toolEnd(session,turn,frame.toolCallId,frame.isError,frame.result);break;
      case 'extension_error':turn.values.set('failure',typeof frame.error==='string'?frame.error:'Pi 扩展执行失败');break;
      case 'auto_retry_end':if(frame.success===false)turn.values.set('failure',typeof frame.finalError==='string'?frame.finalError:'Pi 重试后仍失败');break;
      case 'agent_settled':{
        if(frame.aborted===true||turn.stopRequested){this.fail(session,turn,'INTERRUPTED','Pi 已停止本轮执行',true);return;}
        const failure=turn.values.get('failure'),message=turn.values.get('lastAssistant');
        if(failure||!isRecord(message)||message.stopReason!=='stop'){
          this.fail(session,turn,'PROVIDER_ERROR',typeof failure==='string'?failure:isRecord(message)&&typeof message.errorMessage==='string'?message.errorMessage:'Pi 没有报告正常完成的助手回复',true);return;
        }
        const text=Array.isArray(message.content)?message.content.flatMap(block=>isRecord(block)&&block.type==='text'&&typeof block.text==='string'?[block.text]:[]).join(''):'';
        this.complete(session,turn,text);break;
      }
      // Pi's low-level run end can precede retries/compaction. Wait for settled.
      case 'agent_end':case 'turn_start':case 'turn_end':case 'message_start':case 'tool_execution_update':case 'queue_update':case 'entry_appended':
      case 'session_info_changed':case 'thinking_level_changed':case 'compaction_start':case 'compaction_end':case 'auto_retry_start':
      case 'summarization_retry_scheduled':case 'summarization_retry_attempt_start':case 'summarization_retry_finished':break;
      default:throw Error('Pi 返回了未识别的运行事件，请检查支持版本');
    }
  }
  private meta(ref:SessionRef):PiSessionData{const value=this.metadata.get(ref.id);if(!value)throw new AdapterCallError('RESOURCE_NOT_FOUND','Pi 会话不存在');return value;}
  override async close(ref:SessionRef):Promise<void>{
    await super.close(ref);const meta=this.meta(ref);
    if(meta.systemFile){const file=meta.systemFile;meta.systemFile=null;try{unlinkSync(file);rmdirSync(dirname(file));}catch{/* own temporary instruction file only */}}
  }
  async listModels():Promise<ExternalModel[]>{
    const entry=resolveAgentExecutable('pi',this.options.executable);
    const models=await new Promise<ExternalModel[]>((resolveModels,reject)=>{
      const args=[...entry.prefixArgs,...META_ARGS];
      if(this.options.model){const split=this.options.model.indexOf('/');if(split>0)args.push('--provider',this.options.model.slice(0,split),'--model',this.options.model.slice(split+1));else args.push('--model',this.options.model);}
      const child=spawn(entry.command,args,{cwd:this.options.cwd,windowsHide:true,shell:false,stdio:'pipe'});
      const requestId=randomUUID();let buffer='',matched=false,levelsRead=!this.options.model;let result:ExternalModel[]=[];let levels:string[]=[];
      const finish=()=>{if(matched&&levelsRead){result=result.map(model=>model.id===this.options.model?{...model,efforts:levels}:model);child.stdin.end();}};
      const timer=setTimeout(()=>{child.kill();reject(new AdapterCallError('CAPABILITY_UNSUPPORTED','Pi 模型列表读取超时，请检查 CLI 和配置',true));},this.options.requestTimeoutMs??10000);
      child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');child.stderr.resume();
      child.stdout.on('data',(chunk:string)=>{
        buffer+=chunk;if(buffer.length>2*1024*1024){child.kill();reject(new AdapterCallError('OUTPUT_INVALID','Pi 模型列表超出读取上限',true));return;}
        for(;;){const pos=buffer.indexOf('\n');if(pos<0)break;const line=buffer.slice(0,pos).trim();buffer=buffer.slice(pos+1);if(!line)continue;
          try{const frame:unknown=JSON.parse(line);if(!isRecord(frame)||frame.type!=='response')continue;
            if(frame.id===`${requestId}:levels`){
              if(frame.command!=='get_available_thinking_levels'||frame.success!==true||!isRecord(frame.data)||!Array.isArray(frame.data.levels))throw Error('thinking levels unavailable');
              levels=frame.data.levels.filter((level):level is string=>typeof level==='string'&&['off','minimal','low','medium','high','xhigh'].includes(level)).map(level=>level==='off'?'none':level);
              levelsRead=true;finish();continue;
            }
            if(frame.id!==requestId||frame.command!=='get_available_models')continue;
            if(frame.success!==true||!isRecord(frame.data)||!Array.isArray(frame.data.models))throw Error('model catalog unavailable');
            result=frame.data.models.slice(0,500).flatMap((model:unknown)=>isRecord(model)&&typeof model.provider==='string'&&typeof model.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(`${model.provider}/${model.id}`)?[{id:`${model.provider}/${model.id}`,label:typeof model.name==='string'?model.name.slice(0,120):model.id}]:[]);
            matched=true;finish();
          }catch{child.kill();reject(new AdapterCallError('OUTPUT_INVALID','Pi 模型列表格式无效',true));}
        }
      });
      child.once('error',()=>{clearTimeout(timer);reject(new AdapterCallError('RUNTIME_NOT_FOUND','无法启动 Pi 读取模型列表',true));});
      child.once('close',code=>{clearTimeout(timer);if(matched&&levelsRead&&code===0)resolveModels(result);else reject(new AdapterCallError('CAPABILITY_UNSUPPORTED','Pi 未返回可用模型列表，请检查版本和配置',true));});
      child.stdin.write(`${JSON.stringify({id:requestId,type:'get_available_models'})}\n`);
      if(this.options.model)child.stdin.write(`${JSON.stringify({id:`${requestId}:levels`,type:'get_available_thinking_levels'})}\n`);
    });
    return models;
  }
  async probe():Promise<ProbeResult>{
    const entry=resolveAgentExecutable('pi',this.options.executable);
    const version=await new Promise<string>((resolveVersion,reject)=>execFile(entry.command,[...entry.prefixArgs,'--version'],{cwd:this.options.cwd,windowsHide:true,timeout:10000,maxBuffer:65536},(error,output)=>error?reject(new AdapterCallError('RUNTIME_NOT_FOUND','无法读取 Pi 版本',true)):resolveVersion(output.trim())));
    await this.listModels();return {executable:this.options.executable??'pi',version,capabilities:this.capabilities()};
  }
}
