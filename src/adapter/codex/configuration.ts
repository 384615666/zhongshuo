import { readFileSync, existsSync,realpathSync,statSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const CODEX_CONFIGURATION_FINGERPRINT_VERSION = 3 as const;
export const CODEX_CONFIGURATION_FINGERPRINT_LABEL = 'codex-configuration-v3' as const;
const digest = (value: string|Uint8Array) => createHash('sha256').update(value).digest('hex');

interface TomlFacts {
  scalars: Map<string, string>;
  unsupportedTable: boolean;
}

function parseTomlKeyPath(raw: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index]!)) index++;
    if (index >= raw.length) return null;
    let part = '';
    const quote = raw[index] === '"' || raw[index] === "'" ? raw[index] : null;
    if (quote != null) {
      index++;
      let closed = false;
      while (index < raw.length) {
        let char = raw[index++]!;
        if (char === quote) { closed = true; break; }
        if (quote === '"' && char === '\\') {
          if (index >= raw.length) return null;
          const escaped=raw[index++]!;
          const simple: Record<string,string>={b:'\b',t:'\t',n:'\n',f:'\f',r:'\r','"':'"','\\':'\\'};
          if (simple[escaped]!=null) char=simple[escaped];
          else if (escaped==='u'||escaped==='U') {
            const width=escaped==='u'?4:8,eof=index+width;
            if(eof>raw.length)return null;
            const hex=raw.slice(index,eof);
            if(!/^[0-9A-Fa-f]+$/.test(hex))return null;
            const codePoint=Number.parseInt(hex,16);
            if(!Number.isSafeInteger(codePoint)||codePoint>0x10ffff||(codePoint>=0xd800&&codePoint<=0xdfff))return null;
            char=String.fromCodePoint(codePoint);index=eof;
          } else return null;
        }
        part += char;
      }
      if (!closed || part.length === 0) return null;
    } else {
      const start = index;
      while (index < raw.length && /[A-Za-z0-9_-]/.test(raw[index]!)) index++;
      if (index === start) return null;
      part = raw.slice(start, index);
    }
    parts.push(part);
    while (index < raw.length && /\s/.test(raw[index]!)) index++;
    if (index >= raw.length) return parts;
    if (raw[index] !== '.') return null;
    index++;
  }
  return null;
}

function isWithinPath(candidate:string,cwd:string):boolean {
  if(!isAbsolute(candidate))return true;
  let project:string,target:string;
  try{
    project=realpathSync.native(resolve(candidate));
    target=realpathSync.native(resolve(cwd));
  }catch{return true;}
  const child=relative(project,target);
  if(child==='')return true;
  return !isAbsolute(child)&&child!=='..'&&!child.startsWith(`..${sep}`);
}

interface TomlSection {
  kind:'table'|'array';
  path:string[]|null;
}

function independentSkillArray(section:TomlSection):boolean {
  // v3 recognizes this CLI array without weakening unknown/project arrays.
  // v2 remains byte-for-byte compatible with previously frozen snapshots.
  return section.kind==='array'&&section.path?.length===2&&section.path[0]==='skills'&&section.path[1]==='config';
}

function tomlSection(line:string):TomlSection|null {
  const arrayTable=/^\s*\[\[(.+?)\]\]\s*(?:#.*)?$/.exec(line);
  if(arrayTable){
    const path=parseTomlKeyPath(arrayTable[1]!);
    return {kind:'array',path};
  }
  const table=/^\s*\[(.+?)\]\s*(?:#.*)?$/.exec(line);
  if(table){
    const path=parseTomlKeyPath(table[1]!);
    return {kind:'table',path};
  }
  return null;
}

interface TomlLineState {
  multiline:'"""'|"'''"|null;
  unclosedQuote:boolean;
}

function tomlLineState(line:string,active:'"""'|"'''"|null):TomlLineState {
  let quote:'"'|"'"|null=null;
  for(let i=0;i<line.length;i++){
    const char=line[i]!;
    if(active!=null){
      if(line.startsWith(active,i)){
        let slashes=0;
        for(let j=i-1;j>=0&&line[j]==='\\';j--)slashes++;
        if(active==="'''"||slashes%2===0){
          active=null;i+=2;
        }
      }
      continue;
    }
    if(quote!=null){
      if(quote==='"'&&char==='\\')i++;
      else if(char===quote)quote=null;
      continue;
    }
    if(char==='#')break;
    if(line.startsWith('"""',i)){active='"""';i+=2;continue;}
    if(line.startsWith("'''",i)){active="'''";i+=2;continue;}
    if(char==='"'||char==="'")quote=char;
  }
  return{multiline:active,unclosedQuote:active==null&&quote!=null};
}

/** Codex writes per-project trust entries into the global file. A complete,
 * verified trust-only block for an unrelated path cannot affect execution in
 * cwd; omit only that exact form. Any possible TOML ambiguity falls back to
 * hashing every byte so unknown execution configuration remains guarded. */
function stableCodexConfiguration(text:string,cwd:string,version:2|3):string|null {
  const lines=text.replace(/\r\n?/g,'\n').split('\n');
  const chunks:string[][]=[[]];
  let multiline:'"""'|"'''"|null=null;
  let filteringSafe=true;
  for(const line of lines){
    const section=multiline==null?tomlSection(line):null;
    if(section!=null){
      if(section.path==null||section.kind==='array'&&(version===2||!independentSkillArray(section)))filteringSafe=false;
      chunks.push([line]);
    }else chunks[chunks.length-1]!.push(line);
    const state=tomlLineState(line,multiline);
    if(state.unclosedQuote||(state.multiline!==multiline&&state.multiline!=null&&multiline==null&&!line.includes('=')))filteringSafe=false;
    multiline=state.multiline;
  }
  if(!filteringSafe||multiline!=null)return null;
  const kept:string[]=[];
  for(const chunk of chunks){
    const section=tomlSection(chunk[0]!);
    if(section?.kind==='table'&&section.path!=null&&section.path[0]==='projects'&&section.path.length===2&&!isWithinPath(section.path[1]!,cwd)){
      const payload=chunk.slice(1).filter(line=>{
        const trimmed=line.trim();
        return trimmed!==''&&!trimmed.startsWith('#');
      });
      const trustOnly=payload.every(line=>/^\s*trust_level\s*=\s*["'](?:trusted|untrusted)["']\s*(?:#.*)?$/.test(line));
      if(trustOnly)continue;
    }
    while(chunk.length>0&&chunk[chunk.length-1]!.trim()==='')chunk.pop();
    kept.push(...chunk);
  }
  return kept.join('\n').trimEnd();
}

interface CodexConfigurationFile {
  path:string;
  present:boolean;
  bytes:Uint8Array|null;
}

interface CodexConfigurationState {
  home:string;
  cwd:string;
  files:CodexConfigurationFile[];
  environment:[string,string][];
}

function codexConfigurationEnvironment():[string,string][] {
  return Object.entries(process.env)
    .filter(([key])=>/^(CODEX_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/.test(key))
    .flatMap(([key,value])=>value==null?[]:[[key,value] as [string,string]])
    .sort(([a],[b])=>a.localeCompare(b));
}

/** Capture all Codex configuration inputs once. The bytes remain private to this
 * module; exported evidence contains only versioned digests. */
function collectCodexConfigurationState(cwd:string):CodexConfigurationState {
  const home=resolve(process.env.CODEX_HOME??join(homedir(),'.codex'));
  const paths=new Set([join(home,'config.toml')]);
  let folder=resolve(cwd);
  for(let n=0;n<64;n++){
    paths.add(join(folder,'.codex','config.toml'));
    if(dirname(folder)===folder)break;
    folder=dirname(folder);
    if(n===63)throw Error('Codex 配置层级超出检查范围');
  }
  const files=[...paths].map(path=>{
    try{
      const stat=statSync(path);
      if(stat.size>1048576)throw Error('配置超过有界读取范围');
      return{path,present:true,bytes:readFileSync(path)};
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return{path,present:false,bytes:null};
      throw error;
    }
  });
  return{home,cwd:resolve(cwd),files,environment:codexConfigurationEnvironment()};
}

function legacyCodexConfigurationIdentityFromState(state:CodexConfigurationState):string {
  const facts=state.files.map(file=>[file.path,file.present?digest(file.bytes!):'absent']);
  return digest(JSON.stringify({home:state.home,cwd:state.cwd,facts,env:state.environment}));
}

function currentCodexConfigurationIdentity(state:CodexConfigurationState,version:2|3=3):string {
  const facts=state.files.map(file=>{
    if(!file.present)return[file.path,'absent'];
    const text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes!);
    const stable=stableCodexConfiguration(text,state.cwd,version);
    return[file.path,stable==null?digest(file.bytes!):digest(stable)];
  });
  return digest(JSON.stringify({
    fingerprintVersion:`codex-configuration-v${version}`,
    home:state.home,
    cwd:state.cwd,
    facts,
    env:state.environment,
  }));
}

export interface CodexPreparationConfigurationEvidence {
  readonly fingerprintVersion:typeof CODEX_CONFIGURATION_FINGERPRINT_VERSION;
  readonly identityV1:string;
  readonly identityV2:string;
  readonly fileCount:number;
  readonly environmentEntryCount:number;
}

export type CodexPreparationConfigurationReason =
  | 'unverified-evidence'
  | 'scope-changed'
  | 'environment-changed'
  | 'configuration-set-changed'
  | 'configuration-unreadable'
  | 'non-append-change'
  | 'non-global-trust-append'
  | 'unverified-trust-root'
  | 'existing-or-invalid-trust'
  | 'unexpected-trust-change'
  | null;

export interface CodexPreparationConfigurationComparison {
  readonly ok:boolean;
  readonly outcome:'unchanged'|'trust-initialized'|'changed';
  readonly trustInitializedRoots:readonly string[];
  readonly reason:CodexPreparationConfigurationReason;
}

const preparationEvidence=new WeakMap<CodexPreparationConfigurationEvidence,CodexConfigurationState>();

function sameBytes(left:Uint8Array,right:Uint8Array):boolean {
  if(left.length!==right.length)return false;
  for(let i=0;i<left.length;i++)if(left[i]!==right[i])return false;
  return true;
}

function startsWithBytes(value:Uint8Array,prefix:Uint8Array):boolean {
  if(value.length<prefix.length)return false;
  for(let i=0;i<prefix.length;i++)if(value[i]!==prefix[i])return false;
  return true;
}

function canonicalDirectory(path:string):string|null {
  if(!isAbsolute(path))return null;
  try{
    const canonical=realpathSync.native(resolve(path));
    return statSync(canonical).isDirectory()?canonical:null;
  }catch{return null;}
}

function sameCanonicalPath(left:string,right:string):boolean {
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
}

function directProjectTableRoots(text:string):string[]|null {
  const roots:string[]=[];
  let multiline:'"""'|"'''"|null=null;
  for(const line of text.replace(/\r\n?/g,'\n').split('\n')){
    if(multiline==null){
      if(/^\s*projects\s*[.=]/.test(line))return null;
      const section=tomlSection(line);
      if(section!=null){
        if(section.path==null||section.kind==='array'&&!independentSkillArray(section))return null;
        if(section.path[0]==='projects'){
          if(section.path.length<2)return null;
          roots.push(section.path[1]!);
        }
      }else if(/^\s*\[/.test(line))return null;
    }
    const state=tomlLineState(line,multiline);
    if(state.unclosedQuote)return null;
    multiline=state.multiline;
  }
  return multiline==null?roots:null;
}

function projectRootCounts(roots:readonly string[]):Map<string,number> {
  const counts=new Map<string,number>();
  for(const root of roots)counts.set(root,(counts.get(root)??0)+1);
  return counts;
}

function trustedProjectAppendRoots(suffix:string):string[]|null {
  const lines=suffix.replace(/\r\n?/g,'\n').split('\n');
  const roots:string[]=[];
  let index=0;
  while(index<lines.length){
    while(index<lines.length&&(lines[index]!.trim()===''||lines[index]!.trim().startsWith('#')))index++;
    if(index>=lines.length)break;
    const section=tomlSection(lines[index]!);
    if(section?.kind!=='table'||section.path?.length!==2||section.path[0]!=='projects')return null;
    const root=section.path[1]!;
    index++;
    let trust:null|'trusted'=null;
    while(index<lines.length&&tomlSection(lines[index]!)==null){
      const trimmed=lines[index]!.trim();
      if(trimmed!==''&&!trimmed.startsWith('#')){
        const match=/^trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/.exec(trimmed);
        if(match==null||trust!=null)return null;
        trust='trusted';
      }
      index++;
    }
    if(trust!=='trusted')return null;
    roots.push(root);
  }
  return roots.length===0?null:roots;
}

/** Snapshot the exact effective Codex inputs immediately before preparation.
 * Capture again after close/dispose and pass both records to the comparison
 * helper. Raw bytes stay private; JSON/logging the returned evidence exposes only
 * digest identities and counts, never configuration bodies or credentials. */
export function captureCodexConfigurationPreparation(cwd:string):CodexPreparationConfigurationEvidence {
  const state=collectCodexConfigurationState(cwd);
  const evidence=Object.freeze({
    fingerprintVersion:CODEX_CONFIGURATION_FINGERPRINT_VERSION,
    identityV1:legacyCodexConfigurationIdentityFromState(state),
    identityV2:currentCodexConfigurationIdentity(state,2),
    fileCount:state.files.length,
    environmentEntryCount:state.environment.length,
  });
  preparationEvidence.set(evidence,state);
  return evidence;
}

export function snapshotCodexPreparationConfiguration(cwd:string):CodexPreparationConfigurationEvidence {
  return captureCodexConfigurationPreparation(cwd);
}

function compareCodexConfigurationStates(
  previous:CodexConfigurationState,
  current:CodexConfigurationState,
  allowedTrustRoots:readonly string[],
):CodexPreparationConfigurationComparison {
  if(previous.cwd!==current.cwd||previous.home!==current.home){
    return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'scope-changed'};
  }
  if(JSON.stringify(previous.environment)!==JSON.stringify(current.environment)){
    return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'environment-changed'};
  }
  if(previous.files.length!==current.files.length||previous.files.some((file,index)=>file.path!==current.files[index]?.path)){
    return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'configuration-set-changed'};
  }
  const changed=previous.files.flatMap((file,index)=>{
    const after=current.files[index]!;
    const unchanged=!file.present&&!after.present||file.present&&after.present&&sameBytes(file.bytes!,after.bytes!);
    return unchanged?[]:[{before:file,after}];
  });
  if(changed.length===0)return{ok:true,outcome:'unchanged',trustInitializedRoots:[],reason:null};
  const allowed=allowedTrustRoots.map(canonicalDirectory);
  if(allowed.some(root=>root==null))return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'unverified-trust-root'};
  const allowedSet=new Set(allowed as string[]);
  const initialized:Record<string,string>={};
  const globalConfigPath=join(previous.home,'config.toml');
  for(const pair of changed){
    if(pair.after.path!==globalConfigPath)return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'non-global-trust-append'};
    if(!pair.before.present||!pair.after.present||!startsWithBytes(pair.after.bytes!,pair.before.bytes!)){
      return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'non-append-change'};
    }
    const beforeText=new TextDecoder('utf-8',{fatal:true}).decode(pair.before.bytes!);
    const afterText=new TextDecoder('utf-8',{fatal:true}).decode(pair.after.bytes!);
    const suffix=afterText.slice(beforeText.length);
    if(beforeText.length>0&&!beforeText.endsWith('\n')&&!suffix.startsWith('\n')&&!suffix.startsWith('\r\n')){
      return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'non-append-change'};
    }
    const appended=trustedProjectAppendRoots(suffix);
    const existing=directProjectTableRoots(beforeText);
    const complete=directProjectTableRoots(afterText);
    if(appended==null||existing==null||complete==null)return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'existing-or-invalid-trust'};
    const expected=projectRootCounts(existing);
    for(const root of appended)expected.set(root,(expected.get(root)??0)+1);
    const actual=projectRootCounts(complete);
    if(expected.size!==actual.size||[...expected].some(([root,count])=>actual.get(root)!==count)){
      return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'existing-or-invalid-trust'};
    }
    const existingCanonical=new Set(existing.map(canonicalDirectory).filter((root):root is string=>root!=null));
    for(const rawRoot of appended){
      const root=canonicalDirectory(rawRoot);
      if(root==null||!allowedSet.has(root))return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'unexpected-trust-change'};
      if([...existingCanonical].some(exists=>sameCanonicalPath(exists,root))||initialized[root]!=null){
        return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'existing-or-invalid-trust'};
      }
      initialized[root]=root;
    }
  }
  return{ok:true,outcome:'trust-initialized',trustInitializedRoots:Object.values(initialized),reason:null};
}

/** Compare two in-process evidence captures. A clone, serialized value or
 * evidence from another process cannot verify the private byte snapshot. */
export function codexConfigurationPreparationUnchanged(
  before:CodexPreparationConfigurationEvidence,
  after:CodexPreparationConfigurationEvidence,
  allowedTrustRoots:string[],
):boolean {
  const previous=preparationEvidence.get(before);
  const current=preparationEvidence.get(after);
  if(previous==null||current==null||before.fingerprintVersion!==CODEX_CONFIGURATION_FINGERPRINT_VERSION||after.fingerprintVersion!==CODEX_CONFIGURATION_FINGERPRINT_VERSION)return false;
  return compareCodexConfigurationStates(previous,current,allowedTrustRoots).ok;
}

/** Detailed diagnostic compare that captures the after window itself. */
export function compareCodexPreparationConfiguration(
  before:CodexPreparationConfigurationEvidence,
  cwd:string,
  allowedTrustRoots:readonly string[],
):CodexPreparationConfigurationComparison {
  const previous=preparationEvidence.get(before);
  if(previous==null||before.fingerprintVersion!==CODEX_CONFIGURATION_FINGERPRINT_VERSION){
    return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'unverified-evidence'};
  }
  let current:CodexConfigurationState;
  try{current=collectCodexConfigurationState(cwd);}
  catch{return{ok:false,outcome:'changed',trustInitializedRoots:[],reason:'configuration-unreadable'};}
  return compareCodexConfigurationStates(previous,current,allowedTrustRoots);
}

/** Conservative TOML subset for root scalars and table paths. Quoted table keys are supported;
 * unsupported syntax is surfaced instead of leaving a stale section that can select another profile. */
function parseTomlFacts(text: string): TomlFacts {
  const scalars = new Map<string, string>();
  let section = '';
  let unsupportedTable = false;
  for (const line of text.split(/\r?\n/)) {
    const arrayTable = /^\s*\[\[(.+?)\]\]\s*(?:#.*)?$/.exec(line);
    if (arrayTable) {
      const path = parseTomlKeyPath(arrayTable[1]!);
      if (path == null) {
        unsupportedTable = true;
        section = '';
      } else {
        section = path.join('.');
      }
      continue;
    }
    const table = /^\s*\[(.+?)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      const path = parseTomlKeyPath(table[1]!);
      if (path == null) {
        unsupportedTable = true;
        section = '';
      } else {
        section = path.join('.');
      }
      continue;
    }
    const scalar = /^\s*([\w-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)'|(true|false))\s*(?:#.*)?$/.exec(line);
    if (scalar) scalars.set(`${section}:${scalar[1]}`, scalar[2] ?? scalar[3] ?? scalar[4]!);
  }
  return { scalars, unsupportedTable };
}

/** Conservative invalidation of local source changes; not a capability certification. */
export function codexConfigurationIdentityV2(cwd:string) {
  return currentCodexConfigurationIdentity(collectCodexConfigurationState(cwd),2);
}

export function codexConfigurationIdentity(cwd:string) {
  return currentCodexConfigurationIdentity(collectCodexConfigurationState(cwd));
}

/** Exact pre-R106 Codex v1 identity. This function intentionally hashes raw
 * config bytes and must only be selected for explicitly version-1 scopes. */
export function legacyCodexConfigurationIdentity(cwd:string) {
  return legacyCodexConfigurationIdentityFromState(collectCodexConfigurationState(cwd));
}

export function codexConfigurationIdentityV1(cwd:string) {
  return legacyCodexConfigurationIdentity(cwd);
}

/** Display-only, conservative local TOML subset. Never infers vision/entitlement from configuration. */
export function codexChannelDescription(cwd: string) {
  try {
    const text = readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
    const { scalars, unsupportedTable } = parseTomlFacts(text);
    if (unsupportedTable) return 'Codex 配置含尚未核实的表头，有效渠道需 CLI 核实';
    const provider = scalars.get(':model_provider');
    if (provider == null || scalars.has(':profile')) return '无法确定 Codex 有效 provider（默认或 profile 覆盖需 CLI 核实）';
    for (let folder = resolve(cwd); ; folder = dirname(folder)) {
      if (existsSync(join(folder, '.codex', 'config.toml'))) return `${provider}（存在项目配置覆盖，有效渠道需 CLI 核实）`;
      if (dirname(folder) === folder) break;
    }
    const base = scalars.get(`model_providers.${provider}:base_url`);
    let address = '默认地址由登录方式决定';
    if (base != null) { const u = new URL(base); address = u.origin + u.pathname; }
    return `${provider} · ${scalars.get(`model_providers.${provider}:wire_api`) ?? '协议需 CLI 核实'} · ${address}`;
  } catch { return 'Codex 配置不可读或有效渠道无法确定'; }
}

export interface CodexDefaultMetadata {
  model: string | null;
  effort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' | null;
  provider: string | null;
  reason: string | null;
}

/** Read the effective global model when no project-level Codex override can change it.
 * Only root/profile metadata is returned; credentials and provider environment stay private. */
export function resolveCodexDefaultMetadata(cwd: string): CodexDefaultMetadata {
  let text: string;
  try {
    const userHome = resolve(homedir());
    const home = resolve(process.env.CODEX_HOME ?? join(userHome, '.codex'));
    const globalPath = join(home, 'config.toml');
    const stat = statSync(globalPath);
    if (stat.size > 1024 * 1024) return { model: null, effort: null, provider: null, reason: 'Codex 全局配置超过有界读取范围' };
    text = readFileSync(globalPath, 'utf8');
    for (let folder = resolve(cwd); ; folder = dirname(folder)) {
      const candidate = join(folder, '.codex', 'config.toml');
      if (folder !== userHome && candidate !== globalPath && existsSync(candidate)) {
        return { model: null, effort: null, provider: null, reason: '项目 Codex 配置可能覆盖全局默认，需由 CLI 核实' };
      }
      if (dirname(folder) === folder) break;
    }
  } catch {
    return { model: null, effort: null, provider: null, reason: 'Codex 全局配置不可读' };
  }
  const { scalars, unsupportedTable } = parseTomlFacts(text);
  if (unsupportedTable) return { model: null, effort: null, provider: null, reason: 'Codex 全局配置含尚未核实的表头，需由 CLI 核实' };
  const profile = scalars.get(':profile');
  const profilePrefix = profile != null ? `profiles.${profile}:` : '';
  const model = scalars.get(`${profilePrefix}model`) ?? scalars.get(':model') ?? null;
  const effortValue = scalars.get(`${profilePrefix}model_reasoning_effort`) ?? scalars.get(':model_reasoning_effort') ?? null;
  const effort = effortValue != null && ['none','minimal','low','medium','high','xhigh','max'].includes(effortValue)
    ? effortValue as CodexDefaultMetadata['effort']
    : null;
  const provider = scalars.get(`${profilePrefix}model_provider`) ?? scalars.get(':model_provider') ?? null;
  return {
    model: model != null && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(model) && !model.startsWith('sk-') ? model : null,
    effort,
    provider,
    reason: model == null ? 'Codex 全局配置未声明可识别的默认模型' : null,
  };
}
