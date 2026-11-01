import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentExecutable } from '../../src/adapter/cli/executable.ts';
import { externalRuntimeLaunchIdentity } from '../../src/adapter/cli/configuration.ts';
import { PiAdapter } from '../../src/adapter/pi/adapter.ts';

const roots: string[] = [];
function directory() { const dir=mkdtempSync(join(tmpdir(),'zs-cli-r136-'));roots.push(dir);return dir; }
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('external CLI launch resolution',()=>{
  it('resolves npm and pnpm Windows shims to their literal JS target without executing batch commands',()=>{
    const dir=directory(),entry=join(dir,'node_modules','@deepseek-ai','dsh','bin.mjs');mkdirSync(join(dir,'node_modules','@deepseek-ai','dsh'),{recursive:true});writeFileSync(entry,'// fixture');
    const shim=join(dir,'dsh.cmd');writeFileSync(shim,'@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@deepseek-ai\\dsh\\bin.mjs" %*\r\n');
    expect(resolveAgentExecutable('deepseek-harness',shim)).toEqual({command:process.execPath,prefixArgs:[entry]});
  });
  it('rejects an unrecognized batch wrapper and missing script instead of opening a shell',()=>{
    const dir=directory(),shim=join(dir,'dsh.cmd');writeFileSync(shim,'@echo off\r\ncall arbitrary-command %*');
    expect(()=>resolveAgentExecutable('deepseek-harness',shim)).toThrow('无法解析');
    writeFileSync(shim,'node "%~dp0missing.mjs" %*');expect(()=>resolveAgentExecutable('deepseek-harness',shim)).toThrow('目标不存在');
  });
  it('preserves an explicit JS reference and rejects multiline program references',()=>{
    const path=join(directory(),'pi.mjs');writeFileSync(path,'// fixture');
    expect(resolveAgentExecutable('pi',path)).toEqual({command:process.execPath,prefixArgs:[path]});
    expect(()=>resolveAgentExecutable('pi','pi\nother')).toThrow('无效字符');
  });
  it('fingerprints source and configured inputs while excluding session data and secrets from evidence',()=>{
    const dir=directory(),entry=join(dir,'entry.mjs'),config=join(dir,'config');mkdirSync(config);writeFileSync(entry,'// version A');vi.stubEnv('DSH_HOME',config);vi.stubEnv('DEEPSEEK_API_KEY','sk-fixture-only-secret');
    const options={executable:entry,model:'deepseek/test'};const first=externalRuntimeLaunchIdentity('deepseek-harness',options,dir);
    writeFileSync(join(config,'sessions.json'),'unrelated conversation');expect(externalRuntimeLaunchIdentity('deepseek-harness',options,dir).identityKey).toBe(first.identityKey);
    writeFileSync(entry,'// different executable B');expect(externalRuntimeLaunchIdentity('deepseek-harness',options,dir).identityKey).not.toBe(first.identityKey);
    expect(JSON.stringify(first)).not.toContain('sk-fixture');expect(Object.values(first.launchEvidence).every(hash=>/^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
  it.each(['user','project'] as const)('binds Pi %s MCP configuration while excluding session activity',scope=>{
    const dir=directory(),config=join(dir,'agent'),project=join(dir,'project'),entry=join(dir,'pi.mjs');
    mkdirSync(config);mkdirSync(join(project,'.pi'),{recursive:true});writeFileSync(entry,'// independent CLI fixture');
    vi.stubEnv('PI_CODING_AGENT_DIR',config);
    const options={executable:entry,model:'custom-provider/model-with/slashes'};
    const key=()=>externalRuntimeLaunchIdentity('pi',options,project);
    const absent=key();const file=scope==='user'?join(config,'mcp.json'):join(project,'.pi','mcp.json');
    const first=JSON.stringify({mcpServers:{local:{command:'node',args:['first-server.mjs'],env:{TOKEN:'fixture-secret'}}}});
    writeFileSync(file,first);const installed=key();expect(installed.identityKey).not.toBe(absent.identityKey);
    writeFileSync(file,first.replace('first-server','second-server'));const changed=key();expect(changed.identityKey).not.toBe(installed.identityKey);
    writeFileSync(join(config,'unrelated-session.jsonl'),'conversation state');expect(key().identityKey).toBe(changed.identityKey);
    expect(JSON.stringify(changed)).not.toContain('fixture-secret');expect(JSON.stringify(changed)).not.toContain('second-server');
  });
  it.each(['user','project'] as const)('rejects a Pi turn before spawn when its %s MCP configuration changes after authorization',async scope=>{
    const dir=directory(),config=join(dir,'agent'),project=join(dir,'project'),entry=join(dir,'pi.mjs');
    mkdirSync(config);mkdirSync(join(project,'.pi'),{recursive:true});writeFileSync(entry,'throw Error("must not run");');
    vi.stubEnv('PI_CODING_AGENT_DIR',config);
    const file=scope==='user'?join(config,'mcp.json'):join(project,'.pi','mcp.json');
    writeFileSync(file,JSON.stringify({mcpServers:{fixture:{command:'first'}}}));
    const options={executable:entry,model:'another-gateway/vendor/model'};
    const frozen=externalRuntimeLaunchIdentity('pi',options,project).identityKey;
    let spawns=0;const a=new PiAdapter({...options,spawnFn:()=>{spawns++;throw Error('unexpected spawn');}});
    try{
      const session=await a.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:project,policyId:'full',
        writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'frozen-task',launchConfigurationKey:frozen}});
      writeFileSync(file,JSON.stringify({mcpServers:{fixture:{command:'changed'}}}));
      await expect(a.startTurn(session,{turnId:'turn',dispatchKey:'d',inputBundleId:'b',text:'no inference',policyId:'full',taskRevision:0}))
        .rejects.toMatchObject({code:'STALE_EXECUTION',notStarted:true});
      expect(spawns).toBe(0);
    }finally{await a.disposeAll();}
  });
});
