import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveClaudeConfiguration } from '../../src/adapter/claude/configuration.ts';
import { CLAUDE_ADAPTER_VERSION, ClaudeCliAdapter, claudeLaunchIdentity } from '../../src/adapter/claude/cliAdapter.ts';
import { claudeCertificationMismatches } from '../../src/daemon/imageCapability.ts';
import certification from '../../src/adapter/image-certification-r76.json' with {type:'json'};

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'zs-r77-config-')); roots.push(root);
  const user = join(root,'用户配置'); const cwd = join(root,'项目'); mkdirSync(user); mkdirSync(join(cwd,'.claude'),{recursive:true});
  const settings = join(user,'settings.json');
  const save = (endpoint='https://user.example.test/v1') => writeFileSync(settings,JSON.stringify({env:{ANTHROPIC_BASE_URL:endpoint}})); save();
  return {root,user,cwd,settings,save,env:{CLAUDE_CONFIG_DIR:user,ANTHROPIC_BASE_URL:'https://shell.example.test'} };
}
describe('R77 configuration identity: no model calls, immutable certificate', () => {
  it('R105 exports the exact v1 preimage over current bytes, without substituting the v2 key',()=>{
    const f=fixture();
    const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
    const settings='{"env":{"ANTHROPIC_BASE_URL":"https://user.example.test/v1"}}';
    writeFileSync(f.settings,settings);
    const legacy={numStartups:1,pluginUsage:{count:1},tipsHistoryByCommand:{read:1},
      projects:{[f.cwd]:{lastCost:1,allowedTools:['Read']},[join(f.root,'other')]:{lastCost:9}}};
    const legacyPath=join(f.user,'.claude.json');writeFileSync(legacyPath,JSON.stringify(legacy));
    const managedDir=process.platform==='win32'?'C:\\\\Program Files\\\\ClaudeCode':process.platform==='darwin'?'/Library/Application Support/ClaudeCode':'/etc/claude-code';
    const stamps=[
      `${legacyPath}:${digest(JSON.stringify({projects:{[f.cwd]:{allowedTools:['Read'],lastCost:1}},tipsHistoryByCommand:{read:1}}))}`,
      `${f.settings}:${digest(settings)}`,
      `${join(f.cwd,'.claude','settings.json')}:absent`,
      `${join(f.cwd,'.claude','settings.local.json')}:absent`,
      `${join(managedDir,'managed-settings.json')}:absent`,
      `${join(f.user,'managed-settings.json')}:absent`,
    ];
    const before=resolveClaudeConfiguration(f.cwd,[],f.env);
    expect(before.reason).toBeNull();
    expect(before.legacyConfigurationKey).toBe(digest(JSON.stringify({configDir:resolve(f.user),cwd:resolve(f.cwd),stamps,
      routing:[['ANTHROPIC_BASE_URL','https://user.example.test/v1']],extraArgs:[]})));
    expect(before.legacyConfigurationKey).not.toBe(before.configurationKey);
    writeFileSync(legacyPath,JSON.stringify({...legacy,numStartups:2,pluginUsage:{count:2}}));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).legacyConfigurationKey).toBe(before.legacyConfigurationKey);
    writeFileSync(f.settings,JSON.stringify(JSON.parse(settings),null,2)+'\n');
    const formatted=resolveClaudeConfiguration(f.cwd,[],f.env);
    expect(formatted.configurationKey).toBe(before.configurationKey);
    expect(formatted.legacyConfigurationKey).not.toBe(before.legacyConfigurationKey);
    writeFileSync(f.settings,settings);
    writeFileSync(legacyPath,JSON.stringify({...legacy,projects:{[f.cwd]:{allowedTools:['Read'],lastCost:2}}}));
    const statistics=resolveClaudeConfiguration(f.cwd,[],f.env);
    expect(statistics.configurationKey).toBe(before.configurationKey);
    expect(statistics.legacyConfigurationKey).not.toBe(before.legacyConfigurationKey);
    writeFileSync(legacyPath,JSON.stringify({...legacy,tipsHistoryByCommand:{read:2}}));
    const tips=resolveClaudeConfiguration(f.cwd,[],f.env);
    expect(tips.configurationKey).toBe(before.configurationKey);
    expect(tips.legacyConfigurationKey).not.toBe(before.legacyConfigurationKey);
  });
  it('R105 ignores only verified current-project runtime statistics, including their first creation',()=>{
    const f=fixture(),legacy=join(f.user,'.claude.json');
    const key=()=>resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey;
    const before=key();
    const statistics={lastCost:1,lastAPIDuration:2,lastAPIDurationWithoutRetries:3,lastToolDuration:4,
      lastDuration:5,lastLinesAdded:6,lastLinesRemoved:7,lastTotalInputTokens:8,lastTotalOutputTokens:9,
      lastTotalCacheCreationInputTokens:10,lastTotalCacheReadInputTokens:11,lastTotalWebSearchRequests:12,
      lastFpsAverage:13,lastFpsLow1Pct:14,lastModelUsage:{model:{cost:1}},lastSessionId:'fixture-session',
      lastSessionMetrics:{latency:1},lastStartTime:15,lastGracefulShutdown:true,lastVersionBase:'fixture-version'};
    writeFileSync(legacy,JSON.stringify({tipsHistoryByCommand:{read:1},projects:{[f.cwd]:statistics}}));
    expect(key()).toBe(before);
    const project={allowedTools:['Read'],hasTrustDialogAccepted:false,...statistics};
    writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:project}}));const guarded=key();
    expect(guarded).not.toBe(before);
    writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:{...project,lastCost:99,lastSessionMetrics:{latency:99},lastSessionId:'next-session'}}},null,2));
    expect(key()).toBe(guarded);
    writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:{allowedTools:['Read'],hasTrustDialogAccepted:false}}}));
    expect(key()).toBe(guarded);
  });
  it('R105 keeps current-project trust, include approval, MCP, tools and unknown fields guarded',()=>{
    const f=fixture(),legacy=join(f.user,'.claude.json');
    const key=()=>resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey;
    writeFileSync(legacy,'{}');const before=key();
    for(const field of ['allowedTools','hasTrustDialogAccepted','hasClaudeMdExternalIncludesApproved',
      'hasClaudeMdExternalIncludesWarningShown','mcpServers','mcpContextUris','enabledMcpjsonServers',
      'disabledMcpjsonServers','lastUnknownExecutionPolicy','unknownExecutionPolicy']){
      writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:{[field]:{lastCost:'guarded-nested-value'}}}}));
      expect(key(),field).not.toBe(before);
    }
    // State-like names nested inside an execution configuration are not stripped.
    writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:{mcpServers:{lastCost:1}}}}));const nested=key();
    writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:{mcpServers:{lastCost:2}}}}));
    expect(key()).not.toBe(nested);
    for(const value of [null,[],42]){
      writeFileSync(legacy,JSON.stringify({projects:{[f.cwd]:value}}));expect(key()).not.toBe(before);
    }
  });
  it('R105 retains unknown global legacy execution fields instead of ignoring last* patterns',()=>{
    const f=fixture(),legacy=join(f.user,'.claude.json');
    writeFileSync(legacy,'{}');const before=resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey;
    for(const field of ['lastUnknownExecutionPolicy','machineID','userID','installMethod']){
      writeFileSync(legacy,JSON.stringify({[field]:'fixture'}));
      expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey,field).not.toBe(before);
    }
  });
  it.each(['user','project','project-local','managed','legacy'])('R105 canonicalizes JSON objects in %s, preserving array order and unknown values',source=>{
    const f=fixture();
    const path=source==='user'?f.settings:source==='project'?join(f.cwd,'.claude','settings.json')
      :source==='project-local'?join(f.cwd,'.claude','settings.local.json')
      :source==='managed'?join(f.user,'managed-settings.json'):join(f.user,'.claude.json');
    const a={unknownPolicy:{z:1,a:{second:true,first:false}},tools:['Read','Write']};
    writeFileSync(path,JSON.stringify(a));const before=resolveClaudeConfiguration(f.cwd,[],f.env);
    writeFileSync(path,JSON.stringify({tools:['Read','Write'],unknownPolicy:{a:{first:false,second:true},z:1}},null,4)+'\n');
    expect(resolveClaudeConfiguration(f.cwd,[],f.env)).toMatchObject({configurationKey:before.configurationKey,reason:before.reason});
    writeFileSync(path,JSON.stringify({...a,tools:['Write','Read']}));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).not.toBe(before.configurationKey);
    writeFileSync(path,JSON.stringify({...a,unknownPolicy:{...a.unknownPolicy,z:2}}));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).not.toBe(before.configurationKey);
  });
  it('R105 never strips state-named keys from settings files or nested execution data',()=>{
    const f=fixture();const before=resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey;
    for(const settings of [{tipsHistoryByCommand:{read:1}},{lastCost:1},{projects:{[f.cwd]:{lastCost:1}}}]){
      writeFileSync(f.settings,JSON.stringify(settings));
      expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).not.toBe(before);
    }
  });
  it('R83 CLI startup/usage metadata does not invalidate a completed task, actual configuration still does',()=>{
    const f=fixture(),legacy=join(f.user,'.claude.json');
    const absent=resolveClaudeConfiguration(f.cwd,[],f.env);
    writeFileSync(legacy,JSON.stringify({numStartups:1,tipsHistory:{one:1}}));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).toBe(absent.configurationKey);
    const config={mcpServers:{},projects:{[f.cwd]:{allowedTools:['Read']}},numStartups:1,tipsHistory:{one:1},pluginUsage:{}};
    writeFileSync(legacy,JSON.stringify(config));const before=resolveClaudeConfiguration(f.cwd,[],f.env);
    writeFileSync(legacy,JSON.stringify({...config,numStartups:2,tipsHistory:{one:2},pluginUsage:{count:3},projects:{...config.projects,[join(f.root,'别的项目')]:{lastCost:10}}},null,2));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).toBe(before.configurationKey);
    writeFileSync(legacy,JSON.stringify({...config,mcpServers:{engineering:{command:'own-server'}}}));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).not.toBe(before.configurationKey);
    writeFileSync(legacy,JSON.stringify({...config,projects:{[f.cwd]:{allowedTools:['Write']}}}));
    expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).not.toBe(before.configurationKey);
    writeFileSync(legacy,JSON.stringify({...config,env:{ANTHROPIC_BASE_URL:'https://changed.example.test'}}));
    const changed=resolveClaudeConfiguration(f.cwd,[],f.env);expect(changed.configurationKey).not.toBe(before.configurationKey);expect(changed.reason).toContain('渠道覆盖');
    writeFileSync(legacy,JSON.stringify(config));expect(resolveClaudeConfiguration(f.cwd,[],f.env).configurationKey).toBe(before.configurationKey);
  });
  it('CLAUDE_CONFIG_DIR changes effective user endpoint and restoring it restores identity', () => {
    const f=fixture(); const a=resolveClaudeConfiguration(f.cwd,[],f.env);
    expect(a.reason).toBeNull(); expect(a.channel).toBe('https://user.example.test/v1');
    expect(a.env.ANTHROPIC_BASE_URL).toBe('https://shell.example.test'); // CLI, not our resolver, applies settings env.
    const other=join(f.root,'另一个配置');mkdirSync(other);writeFileSync(join(other,'settings.json'),JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://other.example.test'}}));
    const b=resolveClaudeConfiguration(f.cwd,[],{...f.env,CLAUDE_CONFIG_DIR:other});
    expect(b.endpointHash).not.toBe(a.endpointHash); expect(b.configurationKey).not.toBe(a.configurationKey);
    expect(resolveClaudeConfiguration(f.cwd,[],f.env)).toMatchObject({endpointHash:a.endpointHash,configurationKey:a.configurationKey,reason:null});
  });
  it.each(['settings.json','settings.local.json'])('project %s channel override is explicit uncertainty, never guessed certified', filename => {
    const f=fixture(); const a=resolveClaudeConfiguration(f.cwd,[],f.env);
    writeFileSync(join(f.cwd,'.claude',filename),JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://project.example.test'}}));
    const b=resolveClaudeConfiguration(f.cwd,[],f.env);expect(b.reason).toContain('渠道覆盖');expect(b.reason).toContain(filename);expect(b.configurationKey).not.toBe(a.configurationKey);
    expect(claudeCertificationMismatches({...certification,reason:b.reason},certification.model,'plan')).not.toEqual([]);
    expect(resolveClaudeConfiguration(f.root,[],f.env).reason).toBeNull(); // exact project cwd isolation
  });
  it('bad or unreadable JSON cannot become the official endpoint or successful identity', () => {
    const f=fixture();writeFileSync(f.settings,'{ broken');expect(resolveClaudeConfiguration(f.cwd,[],f.env).reason).toContain('解析失败');
    rmSync(f.settings);mkdirSync(f.settings);expect(resolveClaudeConfiguration(f.cwd,[],f.env).reason).toContain('读取');
  });
  it('env, host/provider, proxy, dynamic helper, managed cache and explicit argument sources fail closed', () => {
    const f=fixture();
    for(const key of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST','HTTPS_PROXY']) expect(resolveClaudeConfiguration(f.cwd,[],{...f.env,[key]:'1'}).reason).toContain(key);
    expect(resolveClaudeConfiguration(f.cwd,['--settings','extra.json'],f.env).reason).toContain('启动参数');
    expect(resolveClaudeConfiguration(f.cwd,['--model=other'],f.env).reason).toContain('模型');
    writeFileSync(f.settings,JSON.stringify({apiKeyHelper:'own-helper'}));expect(resolveClaudeConfiguration(f.cwd,[],f.env).reason).toContain('动态凭据');f.save();
    writeFileSync(f.settings,JSON.stringify({env:{CLAUDE_CONFIG_DIR:join(f.root,'redirected')}}));expect(resolveClaudeConfiguration(f.cwd,[],f.env).reason).toContain('重定向');f.save();
    writeFileSync(join(f.user,'managed-settings.json'),JSON.stringify({permissions:{defaultMode:'auto'}}));expect(resolveClaudeConfiguration(f.cwd,[],f.env).reason).toContain('托管');
  });
  it('the frozen R76 certificate stays invalid after the native standing adapter version changed; config restoration does not forge recertification',()=>{
    const identity={executableHash:certification.executableHash,endpointHash:certification.endpointHash,reason:null};
    expect(CLAUDE_ADAPTER_VERSION).not.toBe(certification.adapterVersion);
    const versionMismatch='适配器版本与认证不匹配';
    expect(claudeCertificationMismatches(identity,certification.model,'plan')).toEqual([versionMismatch]);
    expect(claudeCertificationMismatches({...identity,executableHash:'different'},certification.model,'plan')).toEqual(['CLI 字节版本与认证不匹配',versionMismatch]);
    expect(claudeCertificationMismatches({...identity,endpointHash:'different'},certification.model,'plan')).toEqual(['有效渠道与认证不匹配',versionMismatch]);
    expect(claudeCertificationMismatches(identity,'different','plan')[0]).toContain('模型ID');
    expect(claudeCertificationMismatches(identity,certification.model,'auto')[0]).toContain('权限');
    expect(claudeCertificationMismatches(identity,certification.model,'plan')).toEqual([versionMismatch]);
  });
  it('formal adapter checks captured identity before spawn; file/env/CLI changes rejected, restore reaches spawn', async () => {
    const f=fixture();vi.stubEnv('CLAUDE_CONFIG_DIR',f.user);
    const executable=join(f.root,'fixture.cjs');writeFileSync(executable,'// zero-call fixture');
    let spawns=0;const options={executable,model:'deepseek-flash',permissionMode:'plan' as const};
    const adapter=new ClaudeCliAdapter(options,()=>{spawns++;throw new Error('fixture spawn reached');});
    const session=await adapter.openSession({cwd:f.cwd,projectId:'p',memberId:'m',threadId:'th',taskId:'t',policyId:'policy-analyze',sessionGeneration:0});
    const raw=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010800000000','hex');
    const image={artifactId:'own',mime:'image/png' as const,hash:createHash('sha256').update(raw).digest('hex'),dataBase64:raw.toString('base64')};
    const key=claudeLaunchIdentity(options,f.cwd).identityKey;
    const input={turnId:'t',dispatchKey:'d',inputBundleId:'b',text:'',images:[image],imageConfigurationKey:key,policyId:'policy-analyze',taskRevision:0};
    f.save('https://changed.example.test');await expect(adapter.startTurn(session,input)).rejects.toThrow('图片启动配置');expect(spawns).toBe(0);
    f.save();writeFileSync(executable,'// replacement executable');await expect(adapter.startTurn(session,input)).rejects.toThrow('配置');expect(spawns).toBe(0);
    writeFileSync(executable,'// zero-call fixture');await expect(adapter.startTurn(session,input)).rejects.toThrow('fixture spawn reached');expect(spawns).toBe(1);
    await adapter.close(session);
  });
});
