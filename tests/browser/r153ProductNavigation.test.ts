import {describe,expect,it} from 'vitest';

describe('R153 product navigation without transitional menu entries',()=>{
  it('keeps DM management, exports, task records, recovery and current room/thread links usable',async()=>{
    const helper=await import(new URL('./helpers/r153ProductNavigation.cjs',import.meta.url).href) as {
      default:{runVerifier():Promise<{ok:boolean;realBusinessCalls:number;checks:Array<{name:string;ok:boolean}>;evidence:string}>};
    };
    const report=await helper.default.runVerifier();
    expect(report.checks.filter(c=>!c.ok),report.evidence).toEqual([]);
    expect(report.realBusinessCalls).toBe(0);
    expect(report.ok).toBe(true);
  },70_000);
});
