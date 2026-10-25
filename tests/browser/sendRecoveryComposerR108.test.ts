import {describe,expect,it} from 'vitest';

describe('R108 actual Composer send recovery state',()=>{
  it('clears only the recovered request error and preserves a later request error and draft',async()=>{
    const script=new URL('../../scripts/verify-r108-send-recovery-composer.cjs',import.meta.url).href;
    const module=await import(script) as {default:{runVerifier:()=>Promise<{ok:boolean;checks?:Array<{name:string;ok:boolean}>;error?:string}>}};
    const result=await module.default.runVerifier();
    expect(result,JSON.stringify(result)).toMatchObject({ok:true});
    expect(result.checks).toHaveLength(9);
  });
});
