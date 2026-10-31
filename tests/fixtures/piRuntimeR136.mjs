import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const scenario=process.argv[2]??'success';
const value=flag=>process.argv[process.argv.indexOf(flag)+1];
const sessionId=value('--session-id'),file=join(value('--session-dir'),`${sessionId}.jsonl`);
const output=frame=>process.stdout.write(`${JSON.stringify(frame)}\n`);
const reader={close:()=>process.stdin.pause()};
const receive=line=>{
  const command=JSON.parse(line);
  if(command.type==='get_state'){
    output({id:command.id,type:'response',command:'get_state',success:true,data:{sessionId:scenario==='wrong-session'?'other-session':sessionId,sessionFile:file,isStreaming:false,pendingMessageCount:0}});return;
  }
  if(command.type==='abort'){
    output({id:command.id,type:'response',command:'abort',success:true});output({type:'agent_settled',aborted:true});return;
  }
  if(command.type!=='prompt')return;
  writeFileSync(file,JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()})+'\n');
  output({id:command.id,type:'response',command:'prompt',success:true,data:{disposition:'started'}});
  if(scenario==='ack-only'){reader.close();process.stdin.destroy();return;}
  output({type:'agent_start'});
  if(scenario==='hang')return;
  if(scenario==='malformed'){process.stdout.write('null\n');return;}
  if(scenario==='dialog'){output({type:'extension_ui_request',id:'permission',method:'confirm',title:'Allow?'});return;}
  const complete=()=>{
    const developer=process.argv.includes('--append-system-prompt')?readFileSync(value('--append-system-prompt'),'utf8'):null;
    const content=JSON.stringify({prompt:command.message,developer,sessionId});
    output({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'中文🙂\u2028\u2029literal'}});
    output({type:'tool_execution_start',toolCallId:'tool',toolName:'read',args:{path:'input.txt'}});
    output({type:'tool_execution_end',toolCallId:'tool',toolName:'read',isError:false,result:{text:'not copied'}});
    output({type:'message_end',message:{role:'assistant',content:[{type:'text',text:content}],stopReason:scenario==='error'?'error':scenario==='truncated'?'length':'stop',model:'fixture',usage:{input:10,output:5,cacheRead:3,cost:{total:0.01}}}});
    output({type:'agent_end',willRetry:false,messages:[]});
    if(scenario==='end-only'){reader.close();process.stdin.destroy();return;}
    output({type:'agent_settled',aborted:false});
  };
  if(scenario==='retry'){
    output({type:'message_end',message:{role:'assistant',content:[],stopReason:'error'}});output({type:'agent_end',willRetry:true,messages:[]});
    output({type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:30});setTimeout(complete,30);
  }else complete();
};
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const index=buffer.indexOf('\n');if(index<0)break;const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())receive(line);}});
