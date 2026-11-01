import {describe,expect,it} from 'vitest';
import {readTaskDetails} from '../../src/daemon/taskDetails.ts';
import type {TaskDetailsResult} from '../../src/contracts/taskDetails.ts';
import {dispatchBlockedFixture,dispatchBlockedReasons} from '../fixtures/dispatchBlockedR154.ts';

describe('R154 visible member failures before a run exists',()=>{
  it('renders authoritative failures in current run/member details and keeps history separate',async()=>{
    const {db,event}=dispatchBlockedFixture();
    const cases:Record<string,TaskDetailsResult>={};
    let history:TaskDetailsResult;
    try{
      event('old-child',null,'coordination.dispatchBlocked',{message:'旧轮具体原因'});
      dispatchBlockedReasons.forEach((message,index)=>{event('child',null,'coordination.dispatchBlocked',{message});cases[`reason${index}`]=readTaskDetails(db,'parent');});
      history=readTaskDetails(db,'parent','parent-old');
      cases['missing-message']={...cases.reason0!,memberFailures:cases.reason0!.memberFailures!.map(item=>({...item,failure:{...item.failure,message:null}}))};
      cases['mixed-history']={...cases.reason0!,memberFailures:[...cases.reason0!.memberFailures!,...history.memberFailures!]};
      const oldContract={...cases.reason0!};
      delete oldContract.memberFailures;
      cases['old-contract']=oldContract;
      expect(db.prepare("SELECT count(*) n FROM workflow_runs WHERE task_id='child'").get()).toEqual({n:0});
    }finally{db.close();}
    const helper=await import(new URL('./helpers/memberDispatchFailuresR154.cjs',import.meta.url).href) as {
      default:{runVerifier(config:{cases:Record<string,TaskDetailsResult>;history:TaskDetailsResult;messages:string[]}):Promise<{ok:boolean;realBusinessCalls:number;checks:Array<{name:string;ok:boolean}>;evidence:string}>};
    };
    const report=await helper.default.runVerifier({cases,history,messages:dispatchBlockedReasons});
    expect(report.checks.filter(check=>!check.ok),report.evidence).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.realBusinessCalls).toBe(0);
  },40_000);
});
