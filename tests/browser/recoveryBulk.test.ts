import {describe,expect,it} from 'vitest';

describe('recovery bulk actions',()=>{
  it('hides idle recovery and continues a deduplicated batch with honest retries',async()=>{
    const helper=await import(new URL('./helpers/recoveryBulk.cjs',import.meta.url).href) as {default:{runVerifier():Promise<{ok:boolean;checks:Array<{name:string;ok:boolean}>;evidence:string}>}};
    const result=await helper.default.runVerifier();
    expect(result.checks.filter(check=>!check.ok),result.evidence).toEqual([]);
    expect(result.ok).toBe(true);
  },35_000);
});
