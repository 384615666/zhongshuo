import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileWriteCapability,CLAUDE_PROJECT_WRITE_POLICY_HASH} from '../../src/adapter/writeCapability.ts';
import certificate from '../../src/adapter/write-certification-r82.json' with {type:'json'};
afterEach(()=>vi.unstubAllEnvs());
describe('R82 immutable real file-policy evidence, zero added model calls',()=>{
  it('evidence is tied to formal tool arguments; Codex/other models/default readonly do not inherit it',()=>{
    expect(CLAUDE_PROJECT_WRITE_POLICY_HASH).toBe(certificate.policyHash);
    for(const r of [{kind:'codex',model:'gpt-6-luna',permissionMode:'acceptEdits',executable:null},{kind:'claude',model:'deepseek-flash',permissionMode:'acceptEdits',executable:null},{kind:'claude',model:'glm-5.3-flash',permissionMode:'plan',executable:null}])expect(fileWriteCapability(r,process.cwd()).status).not.toBe('supported');
  });
  it('a referenced script cannot impersonate the certified native CLI; changed config directory/endpoint stays unverified',()=>{
    const root=mkdtempSync(join(tmpdir(),'r82-cert-')),config=join(root,'configuration');mkdirSync(config);writeFileSync(join(config,'settings.json'),JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:1'}}));vi.stubEnv('CLAUDE_CONFIG_DIR',config);
    const exe=join(root,process.platform==='win32'?'not-native.exe':'not-native');writeFileSync(exe,'ENGINEERING REFERENCES ONLY - NEVER EXECUTED');
    const result=fileWriteCapability({kind:'claude',model:'glm-5.3-flash',permissionMode:'acceptEdits',executable:exe},root);expect(result.status).toBe('unverified');expect(result.reason).toMatch(/字节|渠道/);expect(certificate.executableHash).not.toBe('ENGINEERING REFERENCES ONLY');
  });
});
