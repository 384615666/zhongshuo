import process from 'node:process';
let buffer='';process.stdin.setEncoding('utf8');
const send=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
const scenario=process.argv[2];
send({v:1,type:'ready',runtime:'zhongshuo-dsh',protocol:1,capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true,outputSchema:true,formatRepair:true,privateSessions:true,planningOnly:scenario!=='old'}});
process.stdin.on('data',chunk=>{
  buffer+=chunk;let pos;
  while((pos=buffer.indexOf('\n'))>=0){
    const command=JSON.parse(buffer.slice(0,pos));buffer=buffer.slice(pos+1);
    if(command.type!=='execute')continue;
    send({v:1,type:'session',requestId:command.requestId,sessionId:'r152-planning',resumed:false});
    if(scenario==='tool')send({v:1,type:'event',requestId:command.requestId,event:{kind:'tool-start',id:'denied',name:'read',input:{path:'private'}}});
    send({v:1,type:'result',requestId:command.requestId,sessionId:'r152-planning',status:'completed',stopReason:'completed',text:JSON.stringify({mode:command.mode,coordinationPlan:{steps:[{id:'own',assignedMemberId:'self'}]},schema:command.outputSchema})});
  }
});
process.stdin.on('end',()=>process.exit(0));
