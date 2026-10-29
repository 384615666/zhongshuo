import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {
  CODEX_CONFIGURATION_FINGERPRINT_LABEL,
  CODEX_CONFIGURATION_FINGERPRINT_VERSION,
  captureCodexConfigurationPreparation,
  compareCodexPreparationConfiguration,
  codexConfigurationPreparationUnchanged,
  codexConfigurationIdentity,
  codexConfigurationIdentityV2,
  codexConfigurationIdentityV1,
  legacyCodexConfigurationIdentity,
  snapshotCodexPreparationConfiguration,
} from '../../src/adapter/codex/configuration.ts';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const fixtureRoots:string[]=[];
afterEach(()=>{
  vi.unstubAllEnvs();
  for(const root of fixtureRoots.splice(0))rmSync(root,{recursive:true,force:true});
});

function legacyIdentityReference(cwd:string){
  const home=resolve(process.env.CODEX_HOME??join(homedir(),'.codex'));
  const paths=new Set([join(home,'config.toml')]);
  let folder=resolve(cwd);
  for(let n=0;n<64;n++){paths.add(join(folder,'.codex','config.toml'));if(dirname(folder)===folder)break;folder=dirname(folder);if(n===63)throw Error('Codex 配置层级超出检查范围');}
  const facts=[...paths].map(path=>{try{const stat=statSync(path);if(stat.size>1048576)throw Error('配置超过有界读取范围');return{path,identity:createHash('sha256').update(readFileSync(path)).digest('hex')};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{path,identity:'absent'};throw error;}});
  const env=Object.entries(process.env).filter(([key])=>/^(CODEX_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/.test(key)).sort(([a],[b])=>a.localeCompare(b));
  return digest(JSON.stringify({home,cwd:resolve(cwd),facts:facts.map(fact=>[fact.path,fact.identity]),env}));
}

function fixture(){
  const root=process.platform==='win32'
    ? mkdtempSync(join(process.cwd(),'.zs-codex-fingerprint-'))
    : mkdtempSync(join(tmpdir(),'zs-codex-fingerprint-'));
  fixtureRoots.push(root);
  const project=join(root,'project');
  const home=join(root,'codex-home');
  mkdirSync(project);
  mkdirSync(home);
  vi.stubEnv('CODEX_HOME',home);
  const config=join(home,'config.toml');
  const identity=()=>codexConfigurationIdentity(project);
  const snapshot=()=>snapshotCodexPreparationConfiguration(project);
  return{root,project,home,config,identity,snapshot};
}

describe('R106 Codex configuration fingerprint',()=>{
  it('exports v3 while preserving exact historical v1 and v2 identities',()=>{
    const f=fixture(),text='model = "fixture-model"\n';
    writeFileSync(f.config,text);
    const v1=codexConfigurationIdentityV1(f.project),v2=f.identity();
    expect(CODEX_CONFIGURATION_FINGERPRINT_VERSION).toBe(3);
    expect(CODEX_CONFIGURATION_FINGERPRINT_LABEL).toBe('codex-configuration-v3');
    expect(legacyCodexConfigurationIdentity(f.project)).toBe(v1);
    expect(codexConfigurationIdentityV2(f.project)).not.toBe(v2);
    expect(v1).toBe(legacyIdentityReference(f.project));
    expect(v2).not.toBe(v1);
    mkdirSync(join(f.root,'other-project'));
    writeFileSync(f.config,`${text}\n[projects."${join(f.root,'other-project').replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(codexConfigurationIdentityV1(f.project)).not.toBe(v1);
    expect(f.identity()).toBe(v2);
  });

  it('keeps v1 as a raw-byte hash even when the configuration is not valid UTF-8',()=>{
    const f=fixture(),raw=Buffer.from([0x6d,0x6f,0x64,0x65,0x6c,0x3d,0x22,0xff,0x22,0x0a]);
    writeFileSync(f.config,raw);
    expect(legacyCodexConfigurationIdentity(f.project)).toBe(legacyIdentityReference(f.project));
    expect(()=>f.identity()).toThrow();
  });

  it('ignores complete trust-only blocks for unrelated projects',()=>{
    const f=fixture();
    mkdirSync(join(f.root,'other-project'));
    writeFileSync(f.config,'model = "fixture-model"\n');
    const before=f.identity();
    writeFileSync(f.config,`model = "fixture-model"\n\n[projects."${join(f.root,'other-project').replaceAll('\\','\\\\')}"]\ntrust_level = "untrusted"\n`);
    expect(f.identity()).toBe(before);
    writeFileSync(f.config,`model = "fixture-model"\n\n[projects."${join(f.root,'other-project').replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(f.identity()).toBe(before);
  });

  it('ignores unrelated trust with skill arrays while retaining array configuration changes and v2 comparison',()=>{
    const f=fixture(),other=join(f.root,'other-project');mkdirSync(other);
    const base='model = "fixture-model"\n[[skills.config]]\npath = "fixture-skill"\nenabled = true\n';
    writeFileSync(f.config,base);
    const before=f.identity(),v2=codexConfigurationIdentityV2(f.project);
    const trust=`\n[projects."${other.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`;
    writeFileSync(f.config,base+trust);
    expect(f.identity()).toBe(before);
    expect(codexConfigurationIdentityV2(f.project)).not.toBe(v2);
    writeFileSync(f.config,base.replace('enabled = true','enabled = false')+trust);
    expect(f.identity()).not.toBe(before);
  });

  it('prepares current-project trust alongside independent array tables',()=>{
    const f=fixture(),base='[[skills.config]]\npath = "fixture-skill"\nenabled = true\n';
    writeFileSync(f.config,base);const before=f.snapshot();
    writeFileSync(f.config,`${base}\n[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project])).toMatchObject({ok:true,outcome:'trust-initialized'});
  });

  it.each(['current','ancestor'])('keeps %s project trust guarded',which=>{
    const f=fixture();
    const relevant=which==='current'?f.project:f.root;
    const section=`[projects."${relevant.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`;
    writeFileSync(f.config,section);
    const before=f.identity();
    writeFileSync(f.config,section.replace('trusted','untrusted'));
    expect(f.identity()).not.toBe(before);
  });

  it('keeps MCP, unknown project settings and routing environment guarded',()=>{
    const f=fixture();
    mkdirSync(join(f.root,'other-project'));
    writeFileSync(f.config,'model = "fixture-model"\n[mcp_servers.fixture]\ncommand = "first"\n');
    const mcp=f.identity();
    writeFileSync(f.config,'model = "fixture-model"\n[mcp_servers.fixture]\ncommand = "second"\n');
    expect(f.identity()).not.toBe(mcp);

    const unknown=`[projects."${join(f.root,'other-project').replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\nunknown_execution_policy = "first"\n`;
    writeFileSync(f.config,unknown);
    const project=f.identity();
    writeFileSync(f.config,unknown.replace('first','second'));
    expect(f.identity()).not.toBe(project);

    vi.stubEnv('CODEX_ROUTING_FIXTURE','first');
    const routing=f.identity();
    vi.stubEnv('CODEX_ROUTING_FIXTURE','second');
    expect(f.identity()).not.toBe(routing);
  });

  it('falls back to full bytes when project table syntax cannot be filtered safely',()=>{
    const f=fixture();
    const other=join(f.root,'other-project').replaceAll('\\','\\\\');
    writeFileSync(f.config,`[[projects."${other}"]]\ntrust_level = "trusted"\n`);
    const before=f.identity();
    writeFileSync(f.config,`[[projects."${other}"]]\ntrust_level = "untrusted"\n`);
    expect(f.identity()).not.toBe(before);
  });

  it('falls back to full bytes for any array table, not only project array tables',()=>{
    const f=fixture();
    const other=join(f.root,'other-project').replaceAll('\\','\\\\');
    mkdirSync(join(f.root,'other-project'));
    const config=(trust:'trusted'|'untrusted')=>`model = "fixture-model"\n[[mcp_servers.fixture]]\ncommand = "unchanged"\n[projects."${other}"]\ntrust_level = "${trust}"\n`;
    writeFileSync(f.config,config('trusted'));
    const before=f.identity();
    writeFileSync(f.config,config('untrusted'));
    expect(f.identity()).not.toBe(before);
    const withBom=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(config('trusted'))]);
    writeFileSync(f.config,withBom);
    const bom=f.identity();
    writeFileSync(f.config,config('trusted'));
    expect(f.identity()).not.toBe(bom);
  });

  it('keeps trust for paths that cannot be resolved as unrelated',()=>{
    const f=fixture();
    const missing=join(f.root,'missing-project').replaceAll('\\','\\\\');
    writeFileSync(f.config,`[projects."${missing}"]\ntrust_level = "trusted"\n`);
    const before=f.identity();
    writeFileSync(f.config,`[projects."${missing}"]\ntrust_level = "untrusted"\n`);
    expect(f.identity()).not.toBe(before);
  });

  it('never treats table-shaped text inside a multiline string as a project section',()=>{
    const f=fixture();
    const other=join(f.root,'other-project').replaceAll('\\','\\\\');
    const config=(value:string)=>`instructions = """\n${value}\n[projects."${other}"]\ntrust_level = "trusted"\n"""\n`;
    writeFileSync(f.config,config('first'));
    const before=f.identity();
    writeFileSync(f.config,config('second'));
    expect(f.identity()).not.toBe(before);
  });

  it('passes zero-difference preparation snapshots',()=>{
    const f=fixture(),base='model = "fixture-model"\n';
    writeFileSync(f.config,base);
    const before=f.snapshot();
    const result=compareCodexPreparationConfiguration(before,f.project,[f.project,f.root]);
    expect(result).toEqual({ok:true,outcome:'unchanged',trustInitializedRoots:[],reason:null});
    const captured=captureCodexConfigurationPreparation(f.project);
    expect(codexConfigurationPreparationUnchanged(captured,captureCodexConfigurationPreparation(f.project),[f.project,f.root])).toBe(true);
    expect(codexConfigurationPreparationUnchanged(JSON.parse(JSON.stringify(captured)) as typeof captured,captured,[f.project,f.root])).toBe(false);
  });

  it('allows only exact EOF trust initialization for cwd and the explicit worktree root',()=>{
    const f=fixture(),base='model = "fixture-model"\n';
    writeFileSync(f.config,base);
    const before=f.snapshot();
    const appended=[f.project,f.root].map(root=>`\n[projects."${root.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`).join('');
    writeFileSync(f.config,base+appended);
    expect(codexConfigurationPreparationUnchanged(before,captureCodexConfigurationPreparation(f.project),[f.project,f.root])).toBe(true);
    const result=compareCodexPreparationConfiguration(before,f.project,[f.project,f.root]);
    expect(result).toMatchObject({ok:true,outcome:'trust-initialized',reason:null});
    expect(result.trustInitializedRoots.map(root=>resolve(root)).sort()).toEqual([f.root,f.project].map(root=>resolve(root)).sort());
  });

  it('does not treat a project .codex/config.toml append as global CLI trust metadata',()=>{
    const f=fixture(),globalBase='model = "fixture-model"\n',projectConfig=join(f.project,'.codex','config.toml');
    mkdirSync(dirname(projectConfig));
    writeFileSync(f.config,globalBase);
    writeFileSync(projectConfig,'model = "project-model"\n');
    const before=f.snapshot();
    writeFileSync(projectConfig,`model = "project-model"\n[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'non-global-trust-append'});
  });

  it('requires a line break before an appended table and scans the complete after text',()=>{
    const f=fixture(),base='model = "fixture-model"',block=`[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`;
    writeFileSync(f.config,base);
    const before=f.snapshot();
    writeFileSync(f.config,base+block);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'non-append-change'});
    writeFileSync(f.config,`${base}\n${block}`);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:true,outcome:'trust-initialized'});
  });

  it('rejects trust append when the complete old text is structurally unsafe',()=>{
    const f=fixture(),base='model = "unterminated';
    writeFileSync(f.config,base);
    const before=f.snapshot();
    writeFileSync(f.config,`${base}\n[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'existing-or-invalid-trust'});
  });

  it('rejects trust append when the complete text contains an array table',()=>{
    const f=fixture(),base='model = "fixture-model"\n[[mcp_servers.fixture]]\ncommand = "unchanged"\n';
    writeFileSync(f.config,base);
    const before=f.snapshot();
    writeFileSync(f.config,`${base}\n[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'existing-or-invalid-trust'});
  });

  it('rejects changes to an existing trust value even when it remains a trusted table',()=>{
    const f=fixture(),section=`[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "untrusted"\n`;
    writeFileSync(f.config,`model = "fixture-model"\n${section}`);
    const before=f.snapshot();
    writeFileSync(f.config,`model = "fixture-model"\n${section.replace('untrusted','trusted')}`);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false});
  });

  it('rejects duplicate, non-trusted and existing-root trust appends',()=>{
    const f=fixture(),block=(value:'trusted'|'untrusted')=>`[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "${value}"\n`;
    const base='model = "fixture-model"\n';
    writeFileSync(f.config,base);
    const untrusted=f.snapshot();
    writeFileSync(f.config,`${base}\n${block('untrusted')}`);
    expect(compareCodexPreparationConfiguration(untrusted,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'existing-or-invalid-trust'});

    writeFileSync(f.config,`${base}${block('trusted')}`);
    const duplicate=f.snapshot();
    writeFileSync(f.config,`${base}${block('trusted')}\n${block('trusted')}`);
    expect(compareCodexPreparationConfiguration(duplicate,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'existing-or-invalid-trust'});
  });

  it('rejects unrelated trust appends and unknown fields even when appended at EOF',()=>{
    const f=fixture(),base='model = "fixture-model"\n';
    mkdirSync(join(f.root,'other-project'));
    writeFileSync(f.config,base);
    const unrelated=f.snapshot();
    writeFileSync(f.config,`${base}\n[projects."${join(f.root,'other-project').replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
    expect(compareCodexPreparationConfiguration(unrelated,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'unexpected-trust-change'});

    writeFileSync(f.config,base);
    const unknown=f.snapshot();
    writeFileSync(f.config,`${base}\n[projects."${f.project.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\nunknown_policy = true\n`);
    expect(compareCodexPreparationConfiguration(unknown,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'existing-or-invalid-trust'});
  });

  it.each(['model','provider','mcp','permission','unknown'])('rejects preparation-window %s changes that are not the exact trust append',field=>{
    const f=fixture(),base='model = "fixture-model"\n';
    writeFileSync(f.config,base);
    const before=f.snapshot();
    const changed=field==='provider'?'model_provider = "changed"\n'
      :field==='mcp'?'model = "fixture-model"\n[mcp_servers.fixture]\ncommand = "changed"\n'
      :field==='permission'?'model = "fixture-model"\n[permissions]\nmode = "changed"\n'
      :field==='unknown'?'model = "fixture-model"\nunknown_execution_policy = true\n'
      :'model = "changed"\n';
    writeFileSync(f.config,changed);
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false});
  });

  it('rejects environment drift even when config bytes are otherwise unchanged',()=>{
    const f=fixture(),base='model = "fixture-model"\n';
    writeFileSync(f.config,base);
    const before=f.snapshot();
    vi.stubEnv('CODEX_PREPARATION_FIXTURE','changed');
    expect(compareCodexPreparationConfiguration(before,f.project,[f.project,f.root])).toMatchObject({ok:false,reason:'environment-changed'});
  });
});
