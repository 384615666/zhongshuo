import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startNamedPipeIpc} from '../../src/daemon/namedPipeIpc.ts';
import {connectPipe} from '../../src/contracts/daemonIpc.ts';

it('permission hints return during pending sends while writes remain FIFO and responses stay correlated',async()=>{
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\zs-r121-${randomUUID()}`:join(tmpdir(),`zs-r121-${randomUUID()}.sock`);
  let release!:()=>void,started!:()=>void;
  const pending=new Promise<void>(r=>{release=r;}),start=new Promise<void>(r=>{started=r;});
  const order:string[]=[];
  const server=await startNamedPipeIpc(pipe,async raw=>{
    const env=raw as {commandId:string;method:string};
    order.push(env.method);
    if(env.method==='message.submit'){started();await pending;}
    return{commandId:env.commandId,ok:true,data:env.method};
  },{authToken:'fixture-token'});
  const client=await connectPipe(pipe,{token:'fixture-token',requestTimeoutMs:1500});
  try{
    const sending=client.send({commandId:'send-command',method:'message.submit'});
    await start;
    const nextWrite=client.send({commandId:'write-command',method:'navigation.set'});
    const hint=await client.send({commandId:'hint-command',method:'message.writeCapability'});
    expect(hint).toMatchObject({commandId:'hint-command',data:'message.writeCapability'});
    expect(order).toEqual(['message.submit','message.writeCapability']);
    release();
    expect(await sending).toMatchObject({commandId:'send-command',data:'message.submit'});
    expect(await nextWrite).toMatchObject({commandId:'write-command',data:'navigation.set'});
    expect(order).toEqual(['message.submit','message.writeCapability','navigation.set']);
  }finally{release();client.close();await server.close();}
});
