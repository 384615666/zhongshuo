import { createInterface } from 'node:readline';
const scenario = process.argv[2] ?? 'success';
if (process.argv.includes('--zs-probe')) {
  console.log(JSON.stringify({v:1,type:'probe',runtime:'zhongshuo-dsh',protocol:1,pluginVersion:'test',capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true}}));
} else if (process.argv.includes('--zs-models')) {
  console.log(JSON.stringify({v:1,type:'models',runtime:'zhongshuo-dsh',models:[{id:'deepseek/test',label:'Test',efforts:['high']}]}));
} else {
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  let active;
  const reader = createInterface({input:process.stdin});
  reader.on('line', line => {
    const command = JSON.parse(line);
    if (command.type === 'cancel') {
      const finish=()=>{send({v:1,type:'result',requestId:command.requestId,sessionId:active?.sessionId??'',status:'cancelled'});reader.close();process.stdin.destroy();};
      if(scenario==='slow-ready')setTimeout(finish,170);else finish();return;
    }
    if (command.type !== 'execute') return;
    const requestId = scenario === 'wrong-request' ? 'someone-else' : command.requestId;
    const sessionId = scenario === 'wrong-session' ? 'wrong-session' : command.sessionId ?? `${process.env.ZHONGSHUO_DSH_PRIVATE_SESSIONS === '1' ? 'zhongshuo-session-' : 'session-'}${requestId}`;
    active = {sessionId};
    if (scenario === 'malformed') { process.stdout.write('[null]\n'); return; }
    if (scenario === 'no-result') { reader.close(); process.stdin.destroy(); return; }
    send({v:1,type:'session',requestId,sessionId,resumed:Boolean(command.sessionId)});
    if (scenario === 'hang') return;
    const event = data => send({v:1,type:'event',requestId,event:data});
    event({kind:'text',text:'正在处理中文🙂'});
    if (command.mode !== 'format-repair' || scenario === 'repair-tool') {
      event({kind:'tool-start',id:'tool-1',name:'Read',input:{path:'input.txt',token:'sk-not-recorded-secret'}});
      event({kind:'tool-end',id:'tool-1',isError:false,output:'private body should not be persisted'});
    }
    event({kind:'usage',inputTokens:12,cachedTokens:5,outputTokens:3,model:'fixture-model'});
    if (scenario === 'failure') send({v:1,type:'result',requestId,sessionId,status:'failed',error:{code:'AUTH_REQUIRED',message:'Fixture auth error'}});
    else send({v:1,type:'result',requestId,sessionId:scenario==='conflicting-session'?'second-session':sessionId,status:'completed',stopReason:scenario === 'truncated' ? 'max-tokens' : 'completed',text:scenario === 'empty' ? '' : JSON.stringify({prompt:command.prompt,developer:command.developerInstructions??null,schemaVersion:'fixture',sessionId,mode:command.mode,images:command.images??null,outputSchema:command.outputSchema})});
  });
  const handshake = () => send({v:1,type:'ready',runtime:'zhongshuo-dsh',protocol:1,pluginVersion:'test',capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true,...(scenario==='old-plugin'?{}:{outputSchema:true,formatRepair:true,...(scenario==='shared-history-plugin'?{}:{privateSessions:true})})}});
  if (scenario === 'slow-ready') setTimeout(handshake,150);
  else if (scenario === 'cold-start') setTimeout(handshake,10500);
  else if (scenario !== 'no-ready') handshake();
}
