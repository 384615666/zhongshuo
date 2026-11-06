/** Disposable preview data only. A large file still opens without being cached. */
export class ByteLru<T> extends Map<string,T> {
  private sizes=new Map<string,number>();
  private bytes=0;
  private sizeOf:(value:T)=>number;
  private budget:number;
  private maxEntries:number;
  constructor(sizeOf:(value:T)=>number,budget=64*1024*1024,maxEntries=12){super();this.sizeOf=sizeOf;this.budget=budget;this.maxEntries=maxEntries;}
  override get(key:string):T|undefined {
    const value=super.get(key);
    if(value!==undefined){super.delete(key);super.set(key,value);}
    return value;
  }
  override set(key:string,value:T):this {
    this.delete(key);
    const size=Math.max(0,this.sizeOf(value));
    if(size>this.budget)return this;
    while(this.size&&(this.bytes+size>this.budget||this.size>=this.maxEntries))this.delete(this.keys().next().value!);
    super.set(key,value);this.sizes.set(key,size);this.bytes+=size;return this;
  }
  override delete(key:string):boolean {this.bytes-=this.sizes.get(key)??0;this.sizes.delete(key);return super.delete(key);}
  override clear():void {super.clear();this.sizes.clear();this.bytes=0;}
}
