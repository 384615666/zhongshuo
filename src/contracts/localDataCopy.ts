import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants,existsSync,lstatSync,readFileSync,realpathSync,statfsSync} from 'node:fs';
import {copyFile,mkdir,readdir,writeFile,unlink,rmdir} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {atomicWriteFile} from './atomicFile.ts';
import {readDataLocation} from './dataLocation.ts';

export interface DataCopyProgress{phase:'checking'|'copying'|'verifying'|'complete';files:number;totalFiles:number;bytes:number;totalBytes:number}
interface InventoryFile{path:string;bytes:number}
interface CopiedFile extends InventoryFile{sha256:string}
export interface DataCopyResult{container:string;dataRoot:string;files:number;bytes:number;schemaVersion:number;manifestHash:string}
const contained=(parent:string,child:string)=>{const p=relative(parent,child);return !p||p!=='..'&&!p.startsWith('..'+sep)&&!isAbsolute(p);};
const digest=async(file:string)=>{const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);return hash.digest('hex');};
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH';}};
/** Source checks never open SQLite or upgrade the original directory. */
export function assertDataRootClosed(root:string){
  for(const name of ['daemon.pid','desktop-host.pid']){
    const path=join(root,name);if(!existsSync(path))continue;
    const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>256)throw Error('DATA_LINK_REFUSED：关闭记录不是普通文件，未沿链接读取。');
    const pid=Number(readFileSync(path,'utf8').trim());
    if(!Number.isSafeInteger(pid)||pid<=0||alive(pid))throw Error('DATA_SOURCE_IN_USE：这份数据仍可能被应用使用，请完全关闭对应窗口后再试。');
  }
  let proof:{exited?:boolean;forceKilled?:boolean;daemonStopResult?:{complete?:boolean}};
  try{const path=join(root,'desktop-shutdown.json'),stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>1048576)throw Error('invalid close record');proof=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('DATA_CLOSE_UNCONFIRMED：没有正常关闭记录，请先用原版打开并正常关闭这份数据。');}
  if(!proof.exited||proof.forceKilled||proof.daemonStopResult?.complete!==true)throw Error('DATA_CLOSE_UNCONFIRMED：上次关闭未完整结束，原件保留，请先检查原版的恢复状态。');
}
export function findLocalDataRoot(selected:string){
  const base=realpathSync(selected);
  for(const path of [base,join(base,'server-data'),join(base,'data')])if(existsSync(join(path,'state.sqlite'))){
    if(lstatSync(path).isSymbolicLink()||!contained(base,realpathSync(path)))throw Error('DATA_LINK_REFUSED：所选目录中的数据入口指向其他位置，未沿链接读取。');
    return realpathSync(path);
  }
  throw Error('DATA_ROOT_NOT_FOUND：这里没有完整的众说数据，请选择旧包、数据文件夹或完整备份。');
}
export type LocalDataSourceKind='backup'|'physical'|'saved-location';
/** Resolve a user-selected folder the same way the old package's own BAT
 * would: a valid saved-location pointer wins inside a legacy package, while a
 * product backup container is authoritative through its immutable manifest. */
export async function resolveLocalDataSource(selected:string):Promise<{root:string;kind:LocalDataSourceKind;baseRoot:string|null;savedRoot:string|null}>{
  const base=realpathSync(selected);
  if(existsSync(join(base,'data-copy-manifest.json'))) {
    return{root:await verifyDataBackupContainer(base),kind:'backup',baseRoot:null,savedRoot:null};
  }
  for(const candidate of [base,join(base,'server-data'),join(base,'data')]) {
    if(!existsSync(join(candidate,'state.sqlite')))continue;
    if(lstatSync(candidate).isSymbolicLink()||!contained(base,realpathSync(candidate)))throw Error('DATA_LINK_REFUSED：所选目录中的数据入口指向其他位置，未沿链接读取。');
    const effective=readDataLocation(candidate);
    const saved=process.platform==='win32'?effective.toLowerCase()!==resolve(candidate).toLowerCase():effective!==resolve(candidate);
    return{root:effective,kind:saved?'saved-location':'physical',baseRoot:candidate,savedRoot:saved?effective:null};
  }
  throw Error('DATA_ROOT_NOT_FOUND：这里没有完整的众说数据，请选择旧包、数据文件夹或完整备份。');
}
async function inventory(root:string){
  const files:InventoryFile[]=[],dirs:string[]=[];let directories=0;
  const walk=async(dir:string):Promise<void>=>{
    if(++directories>20000)throw Error('DATA_TREE_LIMIT：目录数量超出本次安全读取范围，尚未复制。');
    for(const name of await readdir(dir)){
      const file=join(dir,name),stat=lstatSync(file);
      if(stat.isSymbolicLink())throw Error('DATA_LINK_REFUSED：数据中有链接或重解析目录，未沿链接读取；原件保留。');
      if(stat.isDirectory()){dirs.push(relative(root,file));await walk(file);}
      else if(stat.isFile()){
        if(files.length>=100000)throw Error('DATA_TREE_LIMIT：文件数量超出本次安全读取范围，原件保留。');
        files.push({path:relative(root,file),bytes:stat.size});
      }else throw Error('DATA_ENTRY_UNSUPPORTED：数据中存在无法完整复制的特殊文件。');
    }
  };
  await walk(root);return{files:files.sort((a,b)=>a.path.localeCompare(b.path)),dirs:dirs.sort()};
}
/** Restore checks a completed product backup before it can become a source. */
export async function verifyDataBackupContainer(container:string){
  const base=realpathSync(container),manifestPath=join(base,'data-copy-manifest.json');
  const manifestStat=lstatSync(manifestPath),dataPath=join(base,'data');
  if(manifestStat.isSymbolicLink()||!manifestStat.isFile()||lstatSync(dataPath).isSymbolicLink()||!lstatSync(dataPath).isDirectory()||!contained(base,realpathSync(dataPath)))throw Error('DATA_LINK_REFUSED：备份入口或清单不是容器内的普通文件/目录，未沿链接读取。');
  if(manifestStat.size>32*1024*1024)throw Error('DATA_BACKUP_INVALID：备份清单超出安全读取范围。');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as {format:string;status:string;files:CopiedFile[];directories:string[]};
  if(manifest.format!=='zhongshuo-full-data-v1'||manifest.status!=='complete'||!Array.isArray(manifest.files)||manifest.files.length>100000)throw Error('DATA_BACKUP_INCOMPLETE：这份备份未完整完成，未启用或修改它。');
  const root=realpathSync(join(base,'data')),actual=await inventory(root);
  if(!Array.isArray(manifest.directories)||manifest.directories.length>20000||JSON.stringify([...manifest.directories].sort())!==JSON.stringify(actual.dirs))throw Error('DATA_BACKUP_CHANGED：备份目录结构不匹配，原件保留。');
  if(actual.files.length!==manifest.files.length)throw Error('DATA_BACKUP_CHANGED：备份文件数量不匹配，原件保留。');
  const declared=new Map<string,CopiedFile>();
  for(const file of manifest.files){
    if(typeof file.path!=='string'||isAbsolute(file.path)||!contained(root,resolve(root,file.path))||declared.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('DATA_BACKUP_INVALID：备份清单存在无效文件身份。');
    declared.set(file.path,file);
  }
  for(const file of actual.files){const expected=declared.get(file.path);if(!expected||expected.bytes!==file.bytes||await digest(join(root,file.path))!==expected.sha256)throw Error('DATA_BACKUP_CHANGED：备份文件字节不匹配，原件保留。');}
  return root;
}

/** Complete closed-root preservation. The caller verifies SQLite using the
 * matching bundled Node ABI, on the NEW copy only. No source migration/deletion. */
export async function copyClosedDataRoot(input:{source:string;destinationParent:string;kind:'backup'|'import'|'previous';maxSchemaVersion:number;
  verifyDatabase:(copy:string)=>Promise<{schemaVersion:number}>|{schemaVersion:number};onProgress?:(progress:DataCopyProgress)=>void;
  beforeCopyFile?:(relativePath:string)=>void|Promise<void>;
}):Promise<DataCopyResult>{
  const resolved=await resolveLocalDataSource(input.source),source=resolved.root,parent=realpathSync(input.destinationParent);
  if(!lstatSync(parent).isDirectory())throw Error('DATA_TARGET_INVALID：请选择存放新副本的文件夹。');
  if(contained(source,parent))throw Error('DATA_PATH_OVERLAP：新副本不能放在原数据内部。');
  assertDataRootClosed(source);
  input.onProgress?.({phase:'checking',files:0,totalFiles:0,bytes:0,totalBytes:0});
  const initial=await inventory(source),{files}=initial,bytes=files.reduce((n,file)=>n+file.bytes,0);
  const disk=statfsSync(parent),free=disk.bavail*disk.bsize,needed=Math.ceil((bytes+files.filter(f=>/^state\.sqlite(?:-wal|-shm)?$/.test(f.path)).reduce((n,f)=>n+f.bytes,0))*1.05)+64*1024*1024;
  if(free<needed)throw Error(`DATA_SPACE_INSUFFICIENT：需要约${Math.ceil(needed/1048576)}MB可用空间，当前约${Math.floor(free/1048576)}MB。原数据未改动。`);
  const label={backup:'众说备份',import:'众说数据',previous:'切换前备份'}[input.kind];
  const container=join(parent,`${label}-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`),dataRoot=join(container,'data');
  await mkdir(container,{recursive:false,mode:0o700});await mkdir(dataRoot,{mode:0o700});
  const manifest=join(container,'data-copy-manifest.json');
  await writeFile(manifest,JSON.stringify({format:'zhongshuo-full-data-v1',status:'incomplete',createdAt:Date.now()}),{flag:'wx',mode:0o600});
  for(const dir of initial.dirs)await mkdir(join(dataRoot,dir),{recursive:true,mode:0o700});
  const copied:CopiedFile[]=[];let copiedBytes=0;
  for(const file of files){
    await input.beforeCopyFile?.(file.path);
    const from=join(source,file.path),to=join(dataRoot,file.path);
    if(lstatSync(from).isSymbolicLink()||!contained(source,realpathSync(from)))throw Error('DATA_SOURCE_CHANGED：源目录在读取期间变化，未继续。');
    await mkdir(dirname(to),{recursive:true,mode:0o700});
    if(!contained(dataRoot,realpathSync(dirname(to))))throw Error('DATA_TARGET_CHANGED：目标目录发生变化，原件保留。');
    const before=await digest(from);await copyFile(from,to,constants.COPYFILE_EXCL);
    if(await digest(to)!==before||await digest(from)!==before||lstatSync(from).size!==file.bytes)throw Error('DATA_SOURCE_CHANGED：复制期间源文件变化，原件与未完成副本均保留。');
    copied.push({...file,sha256:before});copiedBytes+=file.bytes;
    input.onProgress?.({phase:'copying',files:copied.length,totalFiles:files.length,bytes:copiedBytes,totalBytes:bytes});
  }
  assertDataRootClosed(source);
  if(JSON.stringify(await inventory(source))!==JSON.stringify(initial))throw Error('DATA_SOURCE_CHANGED：复制期间目录内容变化，副本未启用。');
  input.onProgress?.({phase:'verifying',files:copied.length,totalFiles:files.length,bytes,totalBytes:bytes});
  // Recheck all original bytes after the whole copy, not just each individual file.
  for(const file of copied)if(await digest(join(source,file.path))!==file.sha256)throw Error('DATA_SOURCE_CHANGED：原目录在校验期间变化，副本未启用。');
  // SQLite readonly connections may still create WAL/SHM sidecars. Validate a
  // private scratch copy so the preserved payload remains byte-for-byte exact.
  const scratch=join(container,`.validation-${randomUUID()}`);await mkdir(scratch,{mode:0o700});
  const databaseFiles=['state.sqlite','state.sqlite-wal','state.sqlite-shm'];
  let checked:{schemaVersion:number};
  try{
    for(const name of databaseFiles)if(existsSync(join(dataRoot,name)))await copyFile(join(dataRoot,name),join(scratch,name),constants.COPYFILE_EXCL);
    checked=await input.verifyDatabase(join(scratch,'state.sqlite'));
  }finally{
    // Only these known files in our just-created scratch directory; never a
    // recursive cleanup or any operation on source/profile/user directories.
    for(const name of databaseFiles)try{await unlink(join(scratch,name));}catch{/* leave inaccessible own scratch; payload untouched */}
    try{await rmdir(scratch);}catch{/* unexpected/locked scratch stays intact */}
  }
  if(!Number.isInteger(checked.schemaVersion)||checked.schemaVersion<1||checked.schemaVersion>input.maxSchemaVersion)throw Error('SCHEMA_VERSION_UNSUPPORTED：这份数据需要更新版本，未启用副本。');
  for(const file of copied)if(await digest(join(dataRoot,file.path))!==file.sha256)throw Error('DATA_COPY_CHANGED：副本在校验期间发生变化，未发布完整备份。');
  const text=JSON.stringify({format:'zhongshuo-full-data-v1',status:'complete',createdAt:Date.now(),schemaVersion:checked.schemaVersion,files:copied,directories:initial.dirs,bytes},null,2);
  atomicWriteFile(manifest,text);
  input.onProgress?.({phase:'complete',files:copied.length,totalFiles:files.length,bytes,totalBytes:bytes});
  return{container:resolve(container),dataRoot:resolve(dataRoot),files:copied.length,bytes,schemaVersion:checked.schemaVersion,manifestHash:createHash('sha256').update(text).digest('hex')};
}
