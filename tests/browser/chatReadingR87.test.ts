import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const harness=vi.hoisted(()=>({effects:[] as Array<()=>void|(()=>void)>,refs:[] as Array<{current:unknown}>,saved:{top:400,pinned:false,anchor:'m5',offset:0} as unknown,writes:[] as unknown[]}));
vi.mock('react',()=>({useRef:(current:unknown)=>{const ref={current};harness.refs.push(ref);return ref;},useLayoutEffect:(effect:()=>void|(()=>void))=>harness.effects.push(effect)}));
vi.mock('../../src/ui/hifi/data/readingPositions',()=>({readingNamespace:()=> 'owned-root',readingPosition:()=>harness.saved,saveReadingPosition:(_scope:string,value:unknown)=>harness.writes.push(value)}));
import {useChatReading} from '../../src/ui/hifi/lib/useChatReading.ts';
beforeEach(()=>{harness.effects=[];harness.refs=[];harness.writes=[];harness.saved={top:400,pinned:false,anchor:'m5',offset:0};vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
/** Controlled DOM geometry of the real hook. Native layout is a separate gate. */
function mount(){
  let rowHeight=50,top=0,resize!:()=>void;const events=new Map<string,EventListener>();
  const rows=Array.from({length:6},(_,i)=>({dataset:{readingMessage:`m${i+1}`},getBoundingClientRect:()=>({top:i*rowHeight-top,bottom:(i+1)*rowHeight-top})}));
  const box={children:rows,clientHeight:200,get scrollHeight(){return rows.length*rowHeight;},get scrollTop(){return top;},set scrollTop(value:number){top=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));},querySelectorAll:()=>rows,getBoundingClientRect:()=>({top:0}),addEventListener:(name:string,listener:EventListener)=>events.set(name,listener),removeEventListener:(name:string)=>events.delete(name)};
  vi.stubGlobal('KeyboardEvent',class extends Event{key='';});
  vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){resize=callback;}observe(){}disconnect(){}});
  useChatReading('room-pool:project:room','m1|m2|m3|m4|m5|m6');harness.refs[0]!.current=box;
  const cleanups=harness.effects.map(effect=>effect());
  return{box,layout:(height:number)=>{rowHeight=height;resize();},wheel:()=>events.get('wheel')?.(new Event('wheel')),scroll:(value:number)=>{box.scrollTop=value;events.get('scroll')?.(new Event('scroll'));},unmount:()=>{for(const cleanup of cleanups.reverse())cleanup?.();}};
}
describe('R87 bounded reading restoration across late layout',()=>{
  it('keeps the original m5 anchor after a clamped first layout and restores it when actual heights arrive',()=>{
    const ui=mount();expect(ui.box.scrollTop).toBe(100);ui.layout(100);expect(ui.box.scrollTop).toBe(400);
    vi.advanceTimersByTime(8001);ui.unmount();expect(harness.writes.at(-1)).toMatchObject({top:400,pinned:false,anchor:'m5',offset:0});expect(vi.getTimerCount()).toBe(0);
  });
  it('a user scroll cancels late restoration immediately and preserves the chosen historical position',()=>{
    const ui=mount();ui.wheel();ui.scroll(50);ui.layout(100);expect(ui.box.scrollTop).toBe(50);
    vi.advanceTimersByTime(8001);expect(ui.box.scrollTop).toBe(50);ui.unmount();expect(harness.writes.at(-1)).toMatchObject({top:50,pinned:false});
  });
  it('does not keep reapplying the old anchor after the bounded restore window',()=>{
    const ui=mount();vi.advanceTimersByTime(8001);ui.layout(100);expect(ui.box.scrollTop).toBe(100);ui.unmount();
  });
  it('a reader who was at the bottom follows new content, with all timers removed on unmount',()=>{
    harness.saved={top:400,pinned:true};const ui=mount();expect(ui.box.scrollTop).toBe(100);ui.layout(100);expect(ui.box.scrollTop).toBe(400);ui.unmount();expect(vi.getTimerCount()).toBe(0);
  });
});
