import {createInterface} from 'node:readline';
let nextThread=0,nextTurn=0;
const emit=(method,params)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);if(msg.id==null)return;
 if(msg.method==='initialize'){reply(msg.id,{});return;}
 if(msg.method==='thread/start'){reply(msg.id,{thread:{id:`thread-${++nextThread}`}});return;}
 if(msg.method!=='turn/start'){reply(msg.id,{});return;}
 const n=++nextTurn,id=`turn-${n}`,threadId=msg.params.threadId,text=msg.params.input[0].text;
 const poisoned=text==='inject-unattributed'||text.includes('TOKEN_BAD_SOURCE');
 const resultKey=/resultKey=([A-Za-z0-9_-]+)/.exec(text)?.[1];
 const finalText=resultKey?JSON.stringify({schemaVersion:'task-complete-v1',resultKey,answer:'本请求的正常结果',responseKind:'conversation',changeSummary:'',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]}):text;
 emit('turn/started',{threadId,turn:{id,status:'inProgress'}});
 if(text==='crash-process'){reply(msg.id,{turn:{id,status:'inProgress',items:[]}});setTimeout(()=>process.exit(7),25);return;}
 const send=()=>{
  if(poisoned){
   emit('turn/completed',{turn:{id:'unknown-turn',status:'completed',items:[{type:'agentMessage',text:'UNATTRIBUTED_POISON'}]}});
   emit('item/completed',{item:{type:'agentMessage',id:'bad-message-no-owner',text:'UNATTRIBUTED_VISIBLE_POISON'}});
  }
  else{
   emit('item/started',{threadId,turnId:id,item:{id:'same-tool-id',type:'commandExecution',command:'local-fixture',status:'inProgress'}});
   emit('item/completed',{threadId,turnId:id,item:{id:'same-tool-id',type:'commandExecution',command:'local-fixture',status:'completed'}});
   emit('item/completed',{threadId,turnId:id,item:{id:'same-message-id',type:'agentMessage',text}});
  }
  emit('turn/completed',{threadId,turn:{id,status:'completed',items:[{type:'agentMessage',text:finalText}]}});
 };
 setTimeout(send,poisoned?10:text.includes('TOKEN_VICTIM')?2000:text==='SESSION_SECRET_1'?250:10+(n*13)%70);
 setTimeout(()=>reply(msg.id,{turn:{id,status:'inProgress',items:[]}}),35+(n*7)%45);
});
