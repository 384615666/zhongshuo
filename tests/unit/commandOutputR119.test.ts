import {describe,expect,it} from 'vitest';
import {captureCommandOutput} from '../../src/daemon/commandOutput.ts';

describe('R119 complete command inventories',()=>{
  it('collects stdout beyond the former 64 MiB ceiling without truncating either stream',()=>{
    const size=64*1024*1024+17;
    const result=captureCommandOutput(process.execPath,['-e',`const fs=require('node:fs');fs.writeSync(1,Buffer.alloc(${size},97));fs.writeSync(1,'END\\0');fs.writeSync(2,'diagnostic');`]);
    expect(result.error).toBeUndefined();expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(size+4);expect(result.stdout.endsWith('aEND\0')).toBe(true);
    expect(result.stderr).toBe('diagnostic');
  });
  it('preserves command failure and stderr rather than treating it as an empty inventory',()=>{
    const result=captureCommandOutput(process.execPath,['-e',"process.stderr.write('cannot enumerate');process.exitCode=7"]);
    expect(result.status).toBe(7);expect(result.stderr).toBe('cannot enumerate');expect(result.stdout).toBe('');
  });
  it('passes NUL-delimited stdin intact',()=>{
    const result=captureCommandOutput(process.execPath,['-e',"require('node:fs').writeSync(1,require('node:fs').readFileSync(0))"],'one\0two\0');
    expect(result.status).toBe(0);expect(result.stdout).toBe('one\0two\0');
  });
});
