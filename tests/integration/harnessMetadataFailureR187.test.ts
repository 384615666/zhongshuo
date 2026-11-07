import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekHarnessAdapter } from '../../src/adapter/deepseekHarness/adapter.ts';

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(source: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'zs-r187-harness-')); dirs.push(cwd);
  const executable = join(cwd, 'dsh.mjs'); writeFileSync(executable, source);
  return new DeepSeekHarnessAdapter({ cwd, executable, requestTimeoutMs: 2000 });
}

describe('R187 Harness rejects a skipped incompatible connector promptly', () => {
  it.each(['models', 'probe'])('explains the component upgrade for %s without exposing raw diagnostics', async kind => {
    const adapter = fixture(`process.stderr.write('dsh: skipping profile bundle "@zhongshuo/dsh-runtime": Error: Plugin ');
      setTimeout(()=>process.stderr.write('@zhongshuo/dsh-runtime@0.1.3 is incompatible with dsh 0.2.2-rc.1: private-secret\\n'),20);
      setInterval(()=>{},1000);`);
    const error = await (kind === 'models' ? adapter.listModels() : adapter.probe()).catch(e => e);
    expect(error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', notStarted: true });
    expect(error.message).toContain('setup.cmd');
    expect(error.message).toContain('不兼容');
    expect(error.message).not.toMatch(/private-secret|读取超时|allow-version/);
  });

  it('does not mistake an unrelated skipped extension for our connector', async () => {
    const adapter = fixture(`process.stderr.write('dsh: skipping profile bundle "other-extension": Error: incompatible with dsh\\n');
      console.log(JSON.stringify({v:1,type:'models',runtime:'zhongshuo-dsh',models:[{id:'provider/model',label:'Configured model',efforts:['high']}]}));`);
    await expect(adapter.listModels()).resolves.toEqual([{ id: 'provider/model', label: 'Configured model', efforts: ['high'] }]);
  });
});
