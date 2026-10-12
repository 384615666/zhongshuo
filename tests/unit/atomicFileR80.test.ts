import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFile } from '../../src/contracts/atomicFile.ts';
vi.mock('node:fs',async()=>{const actual=await vi.importActual<typeof fs>('node:fs');return{...actual,writeFileSync:vi.fn(actual.writeFileSync),renameSync:vi.fn(actual.renameSync)};});
const originalFs=await vi.importActual<typeof fs>('node:fs');
afterEach(()=>{vi.restoreAllMocks();vi.mocked(fs.writeFileSync).mockImplementation(originalFs.writeFileSync);vi.mocked(fs.renameSync).mockImplementation(originalFs.renameSync);});
describe('R80 only own temporary-root persistence injections',()=>{
  for(const code of ['ENOSPC','EACCES','INTERRUPTED'])it(`${code} cannot truncate the unique existing original`,()=>{
    const root=fs.mkdtempSync(join(tmpdir(),'r80-original-'));const file=join(root,'原件.bin');fs.writeFileSync(file,'unique original');
    const write=originalFs.writeFileSync;vi.spyOn(fs,'writeFileSync').mockImplementation((target,...rest:unknown[])=>{if(typeof target==='number'){write(target,'partial');throw Object.assign(Error(code),{code});}return Reflect.apply(write,fs,[target,...rest]);});
    try{expect(()=>atomicWriteFile(file,Buffer.from('replacement'))).toThrow(code);expect(fs.readFileSync(file,'utf8')).toBe('unique original');expect(fs.readdirSync(root)).toEqual(['原件.bin']);vi.mocked(fs.writeFileSync).mockImplementation(originalFs.writeFileSync);vi.mocked(fs.renameSync).mockImplementation(originalFs.renameSync);atomicWriteFile(file,'explicit retry');expect(fs.readFileSync(file,'utf8')).toBe('explicit retry');}finally{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});}
  });
  it('rename rejection leaves original and no false success; empty-byte success remains valid',()=>{const root=fs.mkdtempSync(join(tmpdir(),'r80-rename-'));const file=join(root,'empty');fs.writeFileSync(file,'original');try{vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw Error('EACCES');});expect(()=>atomicWriteFile(file,'new')).toThrow();expect(fs.readFileSync(file,'utf8')).toBe('original');vi.mocked(fs.writeFileSync).mockImplementation(originalFs.writeFileSync);vi.mocked(fs.renameSync).mockImplementation(originalFs.renameSync);atomicWriteFile(file,Buffer.alloc(0));expect(fs.statSync(file).size).toBe(0);}finally{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});}});
});
