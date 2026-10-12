import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionMonitor } from '../../src/ui/connectionMonitor.ts';
afterEach(()=>vi.useRealTimers());
describe('R80 shared recovery lifecycle',()=>{
  it('failed recovery keeps one timer and later successful command restores online',async()=>{
    vi.useFakeTimers();let healthy=false;let fail=true;let now=0;const phases:string[]=[];
    const monitor=new ConnectionMonitor({healthy:()=>healthy,connect:async()=>{if(fail)throw Error('EACCES');healthy=true;},notify:f=>phases.push(f.phase),now:()=>now});
    monitor.start();monitor.start();await monitor.tick();expect(monitor.facts.phase).toBe('failed');expect(monitor.metrics.monitorTimers).toBe(1);
    now=5000;fail=false;await monitor.tick();expect(phases).toEqual(['recovering','failed','recovering','online']);
    healthy=false;await monitor.tick();healthy=true;monitor.connected();expect(monitor.facts.phase).toBe('online');monitor.dispose();expect(vi.getTimerCount()).toBe(0);
  });
  it('slow connect coalesces ticks, suspend blocks retries, resume verifies and wall clock jumps do not change retry budget',async()=>{
    vi.useFakeTimers();let release!:()=>void;let attempts=0;let now=0;let healthy=false;let verified=0;
    const monitor=new ConnectionMonitor({healthy:()=>healthy,connect:()=>{attempts++;return new Promise<void>(r=>{release=()=>{healthy=true;r();};});},verify:async()=>{verified++;},notify:()=>{},now:()=>now});
    monitor.start();const read=monitor.tick();await monitor.tick();expect(attempts).toBe(1);monitor.suspend();release();await read;expect(monitor.facts.phase).toBe('suspended');
    vi.setSystemTime(new Date('2099-01-01'));now=10;await monitor.tick();expect(attempts).toBe(1);monitor.resume();await Promise.resolve();release();await Promise.resolve();await Promise.resolve();expect(verified).toBe(1);expect(monitor.facts.phase).toBe('online');monitor.dispose();
  });
});
