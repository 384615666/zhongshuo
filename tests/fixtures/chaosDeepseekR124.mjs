// DeepSeek's terminal-status hypothesis, exercised through a real local pipe.
// This process has no network or model access.
import {createInterface} from 'node:readline';
const mode=process.argv[2];let threads=0,turns=0;
const write=frame=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...frame})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const msg=JSON.parse(line);if(msg.id==null||!msg.method)return;
  const reply=result=>write({id:msg.id,result});
  if(msg.method==='thread/start'){reply({thread:{id:`ds-thread-${++threads}`}});return;}
  if(msg.method!=='turn/start'){reply({});return;}
  const id=`ds-turn-${++turns}`,threadId=msg.params.threadId,text=msg.params.input[0].text;
  const resultKey=/resultKey=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const finalText=JSON.stringify({schemaVersion:'task-complete-v1',resultKey,answer:'协议声称的最终答案',responseKind:'conversation',changeSummary:'',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]});
  write({method:'turn/started',params:{threadId,turn:{id,status:'inProgress'}}});
  reply({turn:{id,status:'inProgress'}});
  const turn={id,items:[{type:'agentMessage',text:finalText}]};
  if(mode!=='missing')turn.status=mode==='null'?null:mode;
  if(mode==='failed')turn.error={kind:'TEST_FAILURE',message:'本地明确失败'};
  setTimeout(()=>write({method:'turn/completed',params:{threadId,turn}}),15);
});
