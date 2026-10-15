/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,module */
const path=require('node:path');
function ownedEvidenceRoot(out,dist){return path.basename(out).startsWith('review-r86-')&&out.startsWith(path.resolve(dist)+path.sep);}
function nativeDelegation(name){return /(?:^|[.:/]|__)(?:Task|Agent|spawn_agent|send_input|send_message_to_agent)$/i.test(String(name??''));}
function nodeTestCommand(command,files){
 // Only actual command segments, not quoted/echoed runner text. Bare --test
 // legitimately discovers the test files in the already checked native cwd.
 const c=String(command??''),segments=[];let start=0,quote=null;
 for(let i=0;i<c.length;i++){const ch=c[i];if(quote){if(ch===quote&&c[i-1]!=='\\')quote=null;continue;}if(ch==='"'||ch==="'"){quote=ch;continue;}if(ch===';'||ch==='\n'||ch==='&'&&c[i+1]==='&'){segments.push(c.slice(start,i));if(ch==='&')i++;start=i+1;}}
 segments.push(c.slice(start));
 return files.length>0&&segments.some(segment=>{const match=/^\s*node(?:\.exe)?\s+(?:--[\w=-]+\s+)*--test(?:\s+(.*?))?\s*$/i.exec(segment);if(!match)return false;const args=match[1]?.trim()??'';if(!args||args.split(/\s+/).every(a=>/^--[\w=-]+$/.test(a)))return true;return files.some(file=>args.split(/\s+/).some(arg=>arg.replace(/^['"]|['"]$/g,'').toLowerCase()===path.basename(file).toLowerCase()));});
}
// eslint-disable-next-line no-control-regex -- Strip native CLI ANSI colors before validating test summaries.
function tapPassed(output){const normalized=String(output).replace(/\u001b\[[0-9;]*m/g,'').replace(/(?:^|\n)\s*ℹ\s*/g,'\n# ');return /(?:^|\n)\s*#\s*tests\s+[1-9]\d*/.test(normalized)&&/(?:^|\n)\s*#\s*pass\s+[1-9]\d*/.test(normalized)&&/(?:^|\n)\s*#\s*fail\s+0\b/.test(normalized);}
function fileRead(command,output,files){const normalized=String(output).replace(/\r\n/g,'\n'),numbered=normalized.replace(/^\s*\d{1,6}: /gm,'');return files.filter(file=>file.content.length>0&&String(command).replace(/\\/g,'/').toLowerCase().includes(path.basename(file.path).toLowerCase())&&[normalized,numbered].some(text=>text.includes(file.content.replace(/\r\n/g,'\n')))).map(({path,sha256,deliveryId,revision,manifestHash})=>({path,sha256,deliveryId,revision,manifestHash}));}
function fileChangePaths(changes,root){const paths=Array.isArray(changes)?changes.map(c=>c.path):changes&&typeof changes==='object'?Object.keys(changes):[];return paths.filter(p=>typeof p==='string').map(p=>path.relative(root,path.resolve(root,p))).filter(p=>p&&!p.startsWith('..')&&!path.isAbsolute(p));}
module.exports={ownedEvidenceRoot,nativeDelegation,nodeTestCommand,tapPassed,fileRead,fileChangePaths};
