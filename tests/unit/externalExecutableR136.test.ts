import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentExecutable } from '../../src/adapter/cli/executable.ts';
import { externalRuntimeLaunchIdentity } from '../../src/adapter/cli/configuration.ts';

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
});
