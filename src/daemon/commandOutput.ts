import {spawnSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,readFileSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function removeOutputFile(path:string) {
  try {unlinkSync(path);} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** File-backed output collection for complete inventories. spawnSync's buffered
 * stdout limit must not decide whether a project can start work. */
export function captureCommandOutput(command:string,args:string[],input?:string) {
  const dir=mkdtempSync(join(tmpdir(),'zs-command-output-'));
  const stdoutPath=join(dir,'stdout'),stderrPath=join(dir,'stderr');
  const descriptors:number[]=[];
  try {
    const stdout= openSync(stdoutPath,'wx');descriptors.push(stdout);
    const stderr= openSync(stderrPath,'wx');descriptors.push(stderr);
    const result=spawnSync(command,args,{input,stdio:['pipe',stdout,stderr],windowsHide:true});
    return {status:result.status,error:result.error,stdout:readFileSync(stdoutPath,'utf8'),stderr:readFileSync(stderrPath,'utf8')};
  } finally {
    for(const descriptor of descriptors)closeSync(descriptor);
    for(const path of [stdoutPath,stderrPath])removeOutputFile(path);
    rmdirSync(dir);
  }
}
