export type ConnectionPhase = 'online' | 'recovering' | 'failed' | 'suspended';
export interface ConnectionFacts { phase:ConnectionPhase; code:string|null; updatedAt:number; attempts:number; }
/** One monitor for the desktop, independent of renderer reloads and command count. */
export class ConnectionMonitor {
  private timer:ReturnType<typeof setInterval>|null=null;
  private busy=false;
  private disposed=false;
  private nextAttempt=0;
  facts:ConnectionFacts={phase:'recovering',code:null,updatedAt:Date.now(),attempts:0};
  private verifyResume=false;
  constructor(private readonly options:{healthy:()=>boolean;connect:()=>Promise<void>;verify?:()=>Promise<void>;notify:(facts:ConnectionFacts)=>void;now?:()=>number;retryMs?:number}){}
  private now(){return this.options.now?.()??performance.now();}
  private update(phase:ConnectionPhase,code:string|null=null){if(this.disposed)return;this.facts={...this.facts,phase,code,updatedAt:Date.now()};this.options.notify({...this.facts});}
  start(){if(this.timer||this.disposed)return;this.timer=setInterval(()=>{void this.tick();},500);this.timer.unref?.();}
  connected(){if(this.facts.phase==='suspended'||this.verifyResume||this.disposed)return;this.nextAttempt=0;if(this.facts.phase!=='online')this.update('online');}
  suspend(){this.update('suspended','HOST_SUSPENDED');}
  resume(){if(this.disposed)return;this.verifyResume=true;this.nextAttempt=0;this.update('recovering');void this.tick();}
  async tick(){
    if(this.disposed||this.busy||this.facts.phase==='suspended')return;
    if(this.options.healthy()&&!this.verifyResume){this.connected();return;}
    if(this.now()<this.nextAttempt)return;
    this.busy=true;this.facts={...this.facts,attempts:this.facts.attempts+1};this.update('recovering');
    try{await this.options.connect();if(this.verifyResume){await this.options.verify?.();this.verifyResume=false;}if(this.facts.phase!=='suspended')this.connected();}
    catch{if(this.facts.phase!=='suspended')this.update('failed','CONNECTION_UNAVAILABLE');this.nextAttempt=this.now()+(this.options.retryMs??5000);}
    finally{this.busy=false;}
  }
  dispose(){this.disposed=true;if(this.timer)clearInterval(this.timer);this.timer=null;}
  get metrics(){return{monitorTimers:this.timer?1:0,inFlight:this.busy?1:0,...this.facts};}
}
