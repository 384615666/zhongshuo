import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {afterAll,describe,expect,it} from 'vitest';
import {ClaudeCliAdapter} from '../../src/adapter/claude/cliAdapter.ts';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import type {
  NormalizedRuntimeEvent,
  OpenSessionInput,
  SessionRef,
  TurnRequest,
} from '../../src/contracts/runtime.ts';

const root=mkdtempSync(join(tmpdir(),'zs-r98-tool-activity-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));

function openInput(cwd:string,memberId:string):OpenSessionInput {
  return {
    projectId:'project-r98',memberId,taskId:'task-r98',threadId:'thread-r98',
    sessionGeneration:0,cwd,policyId:'policy-r98',
  };
}

function turnInput(turnId:string):TurnRequest {
  return {
    turnId,dispatchKey:`dispatch-${turnId}`,inputBundleId:'bundle-r98',
    text:'执行 R98 合成活动检查',policyId:'policy-r98',taskRevision:1,stage:'ISS3',
  };
}

function line(value:unknown):string {
  return `${JSON.stringify(value)}\n`;
}

function claudeProcess(lines:string[]):ChildProcessWithoutNullStreams {
  const handlers=new Map<string,Array<(value?:unknown)=>void>>();
  let killed=false;
  const stdin=Object.assign(new EventEmitter(),{write:()=>true,end:()=>undefined});
  const fake={
    stdin,
    stdout:Object.assign(new EventEmitter(),{setEncoding:()=>undefined}),
    stderr:Object.assign(new EventEmitter(),{setEncoding:()=>undefined}),
    on:(event:string,callback:(value?:unknown)=>void)=>{
      const list=handlers.get(event)??[];
      list.push(callback);handlers.set(event,list);
      return fake;
    },
    kill:()=>{
      killed=true;
      for(const callback of handlers.get('close')??[])callback(0);
    },
  };
  setImmediate(()=>{
    for(const text of lines)if(!killed)fake.stdout.emit('data',text);
    if(!killed)for(const callback of handlers.get('close')??[])callback(0);
  });
  return fake as unknown as ChildProcessWithoutNullStreams;
}

async function collectUntilTerminal(
  adapter:ClaudeCliAdapter|CodexAppServerAdapter,
  session:SessionRef,
  timeoutMs=5_000,
):Promise<NormalizedRuntimeEvent[]> {
  const events:NormalizedRuntimeEvent[]=[];
  const deadline=Date.now()+timeoutMs;
  for await(const event of adapter.events(session)){
    events.push(event);
    if(event.kind==='turn.completed'||event.kind==='turn.failed')break;
    if(Date.now()>deadline)break;
  }
  return events;
}

describe('R98 Claude tool activity transport stub',()=>{
  it('persists action/target/parameters/member/stage and safe factual failure',async()=>{
    const cwd=join(root,'claude-workspace');
    const specPath=join(cwd,'docs','需求拆分.md');
    const lines=[
      line({type:'system',subtype:'init',session_id:'r98-claude-session'}),
      line({type:'assistant',message:{model:'stub',content:[
        {type:'tool_use',id:'read-doc',name:'Read',input:{file_path:specPath,limit:80}},
        {type:'tool_use',id:'search-budget',name:'Grep',input:{pattern:'预算',path:'src',glob:'*.ts'}},
        {type:'tool_use',id:'run-check',name:'Bash',input:{command:'pnpm test --token claude-command-secret',cwd}},
        {type:'tool_use',id:'edit-private',name:'Write',input:{file_path:join(cwd,'src','private.ts'),content:'PRIVATE_WRITE_BODY'}},
      ]}}),
      line({type:'user',message:{content:[
        {type:'tool_result',tool_use_id:'read-doc',content:'PRIVATE_READ_RESULT'},
        {type:'tool_result',tool_use_id:'search-budget',content:'3 matches'},
        {type:'tool_result',tool_use_id:'run-check',is_error:true,content:'permission denied token=claude-result-secret'},
        {type:'tool_result',tool_use_id:'edit-private',content:'written'},
      ]}}),
      line({type:'result',subtype:'success',session_id:'r98-claude-session',result:'完成'}),
    ];
    const adapter=new ClaudeCliAdapter({model:'stub-model'},()=>claudeProcess(lines));
    const session=await adapter.openSession(openInput(cwd,'claude-member'));
    const collecting=collectUntilTerminal(adapter,session);
    await adapter.startTurn(session,turnInput('claude-r98-turn'));
    const events=await collecting;
    await adapter.close(session);

    const started=events.filter((event):event is Extract<NormalizedRuntimeEvent,{kind:'tool.started'}>=>event.kind==='tool.started');
    const completed=events.filter((event):event is Extract<NormalizedRuntimeEvent,{kind:'tool.completed'}>=>event.kind==='tool.completed');
    const startById=Object.fromEntries(started.map(event=>[event.toolCallId,event]));
    expect(started).toHaveLength(4);
    expect(startById['read-doc']).toMatchObject({
      action:'read',target:'docs/需求拆分.md',memberId:'claude-member',stage:'ISS3',
    });
    expect(startById['search-budget']).toMatchObject({action:'search'});
    expect(startById['search-budget']?.target).toContain('预算');
    expect(startById['search-budget']?.target).toContain('src');
    expect(startById['run-check']?.action).toBe('command');
    expect(startById['run-check']?.argumentsSummary).toContain('"command"');
    expect(startById['run-check']?.argumentsSummary).not.toContain('claude-command-secret');
    expect(startById['edit-private']).toMatchObject({action:'edit',target:'src/private.ts'});

    const failed=completed.find(event=>event.toolCallId==='run-check');
    expect(failed).toMatchObject({
      outcome:'failure',action:'command',target:startById['run-check']?.target,
      memberId:'claude-member',stage:'ISS3',resultRef:'permission-denied',
    });
    expect(failed?.resultSummary).toContain('permission denied');
    const serialized=JSON.stringify(events);
    expect(serialized).not.toContain('PRIVATE_WRITE_BODY');
    expect(serialized).not.toContain('PRIVATE_READ_RESULT');
    expect(serialized).not.toContain('claude-command-secret');
    expect(serialized).not.toContain('claude-result-secret');
  },10_000);
});

describe('R98 Codex tool activity transport stub',()=>{
  it('extracts every command/file/MCP/dynamic target and safe failure detail',async()=>{
    const scriptPath=join(root,'codex-activity-mock.mjs');
    writeFileSync(scriptPath,codexActivityMock(),'utf8');
    const adapter=new CodexAppServerAdapter({
      mockEntry:{executable:scriptPath},requestTimeoutMs:5_000,
    });
    const session=await adapter.openSession(openInput('D:/mock','codex-member'));
    const collecting=collectUntilTerminal(adapter,session);
    await adapter.startTurn(session,turnInput('codex-r98-turn'));
    const events=await collecting;
    await adapter.dispose();

    const started=events.filter((event):event is Extract<NormalizedRuntimeEvent,{kind:'tool.started'}>=>event.kind==='tool.started');
    const completed=events.filter((event):event is Extract<NormalizedRuntimeEvent,{kind:'tool.completed'}>=>event.kind==='tool.completed');
    const startById=Object.fromEntries(started.map(event=>[event.toolCallId,event]));
    expect(started).toHaveLength(4);
    expect(started.every(event=>event.memberId==='codex-member'&&event.stage==='ISS3')).toBe(true);
    expect(startById['command-1']).toMatchObject({action:'command'});
    expect(startById['command-1']?.target).toContain('pnpm test');
    expect(startById['files-1']).toMatchObject({action:'edit'});
    expect(startById['files-1']?.target).toContain('a.md');
    expect(startById['files-1']?.target).toContain('docs/b.md');
    expect(startById['files-1']?.argumentsSummary).toContain('docs/b.md');
    expect(startById['mcp-1']).toMatchObject({action:'read',target:'spec.md'});
    expect(startById['mcp-1']?.argumentsSummary).toContain('filesystem');
    expect(startById['dynamic-1']).toMatchObject({action:'edit',target:'src/a.ts'});
    expect(completed.find(event=>event.toolCallId==='files-1')).toMatchObject({
      action:'edit',target:startById['files-1']?.target,
    });

    const failed=completed.find(event=>event.toolCallId==='command-1');
    expect(failed).toMatchObject({
      outcome:'failure',action:'command',target:startById['command-1']?.target,
      memberId:'codex-member',stage:'ISS3',
    });
    expect(failed?.resultSummary).toContain('permission denied');
    const serialized=JSON.stringify(events);
    expect(serialized).not.toContain('PRIVATE_FILE_DIFF');
    expect(serialized).not.toContain('PRIVATE_DYNAMIC_PATCH');
    expect(serialized).not.toContain('codex-command-secret');
    expect(serialized).not.toContain('codex-output-secret');
    expect(serialized).not.toContain('codex-mcp-secret');
  },10_000);
});

function codexActivityMock():string {
  return `import {readFileSync} from 'node:fs';
let buffer='';
const write=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(message,result)=>write({jsonrpc:'2.0',id:message.id,result});
const notify=(method,params)=>write({jsonrpc:'2.0',method,params});
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  buffer+=chunk;
  let index=buffer.indexOf('\\n');
  while(index>=0){
    const line=buffer.slice(0,index).trim();
    buffer=buffer.slice(index+1);
    index=buffer.indexOf('\\n');
    if(line.length>0)handle(JSON.parse(line));
  }
});
function handle(message){
  if(message.method==='initialize'){reply(message,{codexHome:'mock',userAgent:'r98-mock'});return;}
  if(message.method==='thread/start'){reply(message,{thread:{id:'r98-thread'}});return;}
  if(message.method==='turn/start'){
    reply(message,{turn:{id:'r98-provider-turn'}});
    setTimeout(()=>notifications(message.params.threadId),10);
    return;
  }
  if(message.id!=null)reply(message,{});
}
function notifications(threadId){
  const turnId='r98-provider-turn';
  notify('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});
  const items=[
    {type:'commandExecution',id:'command-1',command:'pnpm test --token codex-command-secret',cwd:'D:/mock',status:'inProgress'},
    {type:'fileChange',id:'files-1',status:'inProgress',changes:[
      {path:'D:/mock/a.md',kind:'update',diff:'PRIVATE_FILE_DIFF'},
      {path:'D:/mock/docs/b.md',kind:'add',diff:'PRIVATE_FILE_DIFF'}
    ]},
    {type:'mcpToolCall',id:'mcp-1',server:'filesystem',tool:'read_file',arguments:{file_path:'D:/mock/spec.md',authorization:'Bearer codex-mcp-secret'},status:'inProgress'},
    {type:'dynamicToolCall',id:'dynamic-1',namespace:'editor',tool:'apply_patch',arguments:{file_path:'D:/mock/src/a.ts',patch:'PRIVATE_DYNAMIC_PATCH'},status:'inProgress'}
  ];
  for(const item of items)notify('item/started',{threadId,turnId,item});
  for(const item of items)notify('item/completed',{threadId,turnId,item:item.type==='fileChange'
    ?{type:item.type,id:item.id,status:'completed'}
    :{
      ...item,
      status:item.type==='commandExecution'?'failed':'completed',
      ...(item.type==='commandExecution'?{exitCode:2,aggregatedOutput:'permission denied token=codex-output-secret'}:{})
    }});
  notify('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[
    {type:'agentMessage',id:'final-1',text:'R98 完成'}
  ]}});
}`;
}
