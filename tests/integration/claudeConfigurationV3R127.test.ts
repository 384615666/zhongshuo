import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resolveClaudeConfiguration} from '../../src/adapter/claude/configuration.ts';
import {CLAUDE_ADAPTER_VERSION,ClaudeCliAdapter,claudeLaunchIdentity} from '../../src/adapter/claude/cliAdapter.ts';

const roots:string[]=[];
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'zs-claude-v3-'));roots.push(root);
  const cwd=join(root,'project'),user=join(root,'private-config-dir');
  mkdirSync(join(cwd,'.claude'),{recursive:true});mkdirSync(user);
  const settings=join(user,'settings.json'),legacy=join(user,'.claude.json'),executable=join(root,'fixture.cjs');
  writeFileSync(executable,'// never executed');writeFileSync(settings,'{}');
  const env={CLAUDE_CONFIG_DIR:user};
  return {root,cwd,user,settings,legacy,executable,env,key:()=>resolveClaudeConfiguration(cwd,[],env)};
}

describe('Claude configuration v3: versioned compatibility and hash-only evidence',()=>{
  it.each(['theme','exampleFiles','exampleFilesGeneratedAt','hasUnseenTeamArtifacts'])('ignores only verified %s state in v3; frozen v2 still detects it',field=>{
    const f=fixture();const before=f.key();
    if(field==='theme')writeFileSync(f.settings,JSON.stringify({theme:'light'}));
    else writeFileSync(f.legacy,JSON.stringify({projects:{[f.cwd]:{[field]:field==='exampleFiles'?['fixture']:1}}}));
    const after=f.key();
    expect(after.configurationEvidenceVersion).toBe('claude-configuration-v3');
    expect(after.configurationKey).toBe(before.configurationKey);
    expect(after.configurationEvidence).toEqual(before.configurationEvidence);
    expect(after.previousConfigurationKey).not.toBe(before.previousConfigurationKey);
    expect(after.legacyConfigurationKey).not.toBe(before.legacyConfigurationKey);
  });

  it('reproduces the exact old v2 preimage, including its version and source order',()=>{
    const f=fixture();
    writeFileSync(f.settings,'{"theme":"dark","env":{"ANTHROPIC_BASE_URL":"https://fixture.test"}}');
    writeFileSync(f.legacy,JSON.stringify({pluginUsage:1,projects:{[f.cwd]:{lastCost:2,exampleFiles:['a'],allowedTools:['Read']}}}));
    const managedDir=process.platform==='win32'?'C:\\\\Program Files\\\\ClaudeCode':process.platform==='darwin'?'/Library/Application Support/ClaudeCode':'/etc/claude-code';
    const stamps=[
      `${f.legacy}:${digest(JSON.stringify({projects:{[f.cwd]:{allowedTools:['Read'],exampleFiles:['a']}}}))}`,
      `${f.settings}:${digest('{"env":{"ANTHROPIC_BASE_URL":"https://fixture.test"},"theme":"dark"}')}`,
      `${join(f.cwd,'.claude','settings.json')}:absent`,
      `${join(f.cwd,'.claude','settings.local.json')}:absent`,
      `${join(managedDir,'managed-settings.json')}:absent`,
      `${join(f.user,'managed-settings.json')}:absent`,
    ];
    expect(f.key().previousConfigurationKey).toBe(digest(JSON.stringify({fingerprintVersion:'claude-configuration-v2',
      configDir:resolve(f.user),cwd:resolve(f.cwd),stamps,routing:[['ANTHROPIC_BASE_URL','https://fixture.test']],extraArgs:[]})));
  });

  it('keeps exclusions local to the verified root and source, guarding nested/unknown/permission data',()=>{
    const f=fixture(),before=f.key().configurationKey;
    for(const settings of [{env:{theme:'guarded'}},{permissions:{theme:'guarded'}},{exampleFiles:['guarded']},
      {exampleFilesGeneratedAt:1},{hasUnseenTeamArtifacts:true},{hooks:{event:[]}},{unknownPolicy:true}]){
      writeFileSync(f.settings,JSON.stringify(settings));expect(f.key().configurationKey).not.toBe(before);
    }
    writeFileSync(f.settings,'{}');
    for(const project of [{allowedTools:['Write']},{hasTrustDialogAccepted:true},{hasClaudeMdExternalIncludesApproved:true},
      {hasClaudeMdExternalIncludesWarningShown:true},{mcpServers:{server:{exampleFiles:['guarded']}}},{unknownPolicy:1}]){
      writeFileSync(f.legacy,JSON.stringify({projects:{[f.cwd]:project}}));expect(f.key().configurationKey).not.toBe(before);
    }
    writeFileSync(f.legacy,JSON.stringify({theme:'guarded'}));expect(f.key().configurationKey).not.toBe(before);
  });

  it('hashes paths, credentials, arguments and launch inputs behind fixed safe labels',()=>{
    const f=fixture();vi.stubEnv('CLAUDE_CONFIG_DIR',f.user);
    writeFileSync(f.settings,JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'fixture-secret-token'}}));
    const options={executable:f.executable,model:'fixture-private-model',extraArgs:['fixture-private-argument']};
    const before=claudeLaunchIdentity(options,f.cwd),encoded=JSON.stringify(before.launchEvidence);
    const labels=['配置目录','工作目录','全局旧配置','用户旧配置','用户 settings.json','项目 settings.json',
      '项目 settings.local.json','系统托管配置','缓存托管配置','渠道环境','附加启动参数','执行程序','模型与权限'];
    for(const [label,value] of Object.entries(before.launchEvidence)){
      expect(labels).toContain(label);expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
    for(const secret of [f.root,'fixture-secret-token','fixture-private-model','fixture-private-argument'])expect(encoded).not.toContain(secret);
    const changed=claudeLaunchIdentity({...options,model:'other-model'},f.cwd);
    expect(Object.keys(before.launchEvidence).filter(k=>before.launchEvidence[k]!==changed.launchEvidence[k])).toEqual(['模型与权限']);
    writeFileSync(f.settings,JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'changed-fixture-token'}}));
    const routed=claudeLaunchIdentity(options,f.cwd);
    expect(Object.keys(before.launchEvidence).filter(k=>before.launchEvidence[k]!==routed.launchEvidence[k]).sort()).toEqual(['用户 settings.json','渠道环境'].sort());
    expect(routed.identityKey).not.toBe(before.identityKey);
    expect(claudeLaunchIdentity({...options,effort:undefined},f.cwd).identityKey).toBe(routed.identityKey);
    expect(claudeLaunchIdentity({...options,permissionMode:'bypassPermissions'},f.cwd).identityKey).toBe(routed.identityKey);
  });

  it('returns the exact v2 launch identity without substituting the v3 key',()=>{
    const f=fixture();vi.stubEnv('CLAUDE_CONFIG_DIR',f.user);
    const options={executable:f.executable,model:'fixture-model',permissionMode:'plan' as const,effort:'high'};
    const before=claudeLaunchIdentity(options,f.cwd);
    expect(before.previousIdentityKey).toBe(digest(JSON.stringify({executableHash:before.executableHash,
      model:options.model,permissionMode:options.permissionMode,effort:options.effort,
      adapterVersion:CLAUDE_ADAPTER_VERSION,configurationKey:before.previousConfigurationKey})));
    writeFileSync(f.settings,'{"theme":"light"}');
    const after=claudeLaunchIdentity(options,f.cwd);
    expect(after.identityKey).toBe(before.identityKey);expect(after.previousIdentityKey).not.toBe(before.previousIdentityKey);
  });

  it('formal adapter accepts display-only changes but rejects real configuration before spawn',async()=>{
    const f=fixture();vi.stubEnv('CLAUDE_CONFIG_DIR',f.user);
    const options={executable:f.executable,model:'fixture-model'};
    const before=claudeLaunchIdentity(options,f.cwd);
    let spawns=0;
    const adapter=new ClaudeCliAdapter(options,()=>{spawns++;throw Error('fixture spawn reached');});
    const session=await adapter.openSession({cwd:f.cwd,projectId:'p',memberId:'m',threadId:'th',taskId:'t',
      policyId:'policy-full-access',sessionGeneration:0,writeAccess:{fullAccess:true,modificationAuthorized:true,
        allowedWriteRoots:[],identityKey:'fixture',launchConfigurationKey:before.identityKey}});
    const input={turnId:'t',dispatchKey:'d',inputBundleId:'b',text:'fixture',policyId:'policy-full-access',taskRevision:0};
    writeFileSync(f.settings,'{"theme":"light"}');
    writeFileSync(f.legacy,JSON.stringify({projects:{[f.cwd]:{exampleFiles:['a'],exampleFilesGeneratedAt:1,hasUnseenTeamArtifacts:true}}}));
    await expect(adapter.startTurn(session,input)).rejects.toThrow('fixture spawn reached');expect(spawns).toBe(1);
    writeFileSync(f.settings,'{"permissions":{"defaultMode":"plan"}}');
    await expect(adapter.startTurn(session,input)).rejects.toThrow('启动配置已变化');expect(spawns).toBe(1);
    await adapter.close(session);
  });
});
