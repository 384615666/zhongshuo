/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,module */
const path=require('node:path');
function ownedEvidenceRoot(out,dist){return path.basename(out).startsWith('review-r86-')&&out.startsWith(path.resolve(dist)+path.sep);}
function nativeDelegation(name){return /(?:^|[.:/])(?:Task|Agent|spawn_agent|send_input|send_message_to_agent)$/i.test(String(name??''));}
function nodeTestCommand(command,files){
 const c=String(command??'');
 // Only actual test-runner invocation, never an echoed command or node -e self-report.
 if(/\b(?:echo|printf)\b|\bnode(?:\.exe)?\s+-(?:e|p)\b/i.test(c))return false;
 if(!/(?:^|[\s;&|"'])node(?:\.exe)?["']?\s+(?:--[^\s]+\s+)*--test(?:\s|$)/i.test(c))return false;
 return files.some(file=>c.toLowerCase().includes(path.basename(file).toLowerCase()));
}
function tapPassed(output){return /(?:^|\n)\s*#\s*tests\s+[1-9]\d*/.test(output)&&/(?:^|\n)\s*#\s*pass\s+[1-9]\d*/.test(output)&&/(?:^|\n)\s*#\s*fail\s+0\b/.test(output);}
function fileRead(command,output,files){return files.filter(file=>file.content.length>0&&String(command).replace(/\\/g,'/').toLowerCase().includes(path.basename(file.path).toLowerCase())&&String(output).replace(/\r\n/g,'\n').includes(file.content.replace(/\r\n/g,'\n'))).map(({path,sha256,deliveryId,revision,manifestHash})=>({path,sha256,deliveryId,revision,manifestHash}));}
module.exports={ownedEvidenceRoot,nativeDelegation,nodeTestCommand,tapPassed,fileRead};
