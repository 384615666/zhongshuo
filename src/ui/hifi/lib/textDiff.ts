export interface DiffLine {type:'same'|'add'|'del';text:string;leftNo?:number;rightNo?:number}
export interface LineDiff {lines:DiffLine[];mode:'exact'|'blocks'|'large';added:number;removed:number}
const MAX_CHARS=1_000_000,MAX_LINES=50_000,MAX_CELLS=1_000_000;
const split=(text:string)=>text===''?[]:text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');

/** Exact middle: at most 1MB of directions and two linear score rows. Common
 * edges are trimmed first; larger middles become honest delete/add blocks. */
export function buildLineDiff(left:string,right:string):LineDiff{
  if(left.length>MAX_CHARS||right.length>MAX_CHARS)return{lines:[],mode:'large',added:0,removed:0};
  const a=split(left),b=split(right);
  if(a.length>MAX_LINES||b.length>MAX_LINES)return{lines:[],mode:'large',added:0,removed:0};
  let prefix=0,suffix=0;
  while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const n=a.length-prefix-suffix,m=b.length-prefix-suffix,lines:DiffLine[]=[];
  let ln=1,rn=1,added=0,removed=0;
  const same=(text:string)=>lines.push({type:'same',text,leftNo:ln++,rightNo:rn++});
  const del=(text:string)=>{removed++;lines.push({type:'del',text,leftNo:ln++});};
  const add=(text:string)=>{added++;lines.push({type:'add',text,rightNo:rn++});};
  for(let i=0;i<prefix;i++)same(a[i]);
  const mode=n*m>MAX_CELLS?'blocks':'exact';
  if(mode==='blocks'||n===0||m===0){
    for(let i=0;i<n;i++)del(a[prefix+i]);
    for(let j=0;j<m;j++)add(b[prefix+j]);
  }else{
    const directions=new Uint8Array(n*m);
    let next=new Uint32Array(m+1),current=new Uint32Array(m+1);
    for(let i=n-1;i>=0;i--){
      current[m]=0;
      for(let j=m-1;j>=0;j--){
        const at=i*m+j;
        if(a[prefix+i]===b[prefix+j]){current[j]=next[j+1]+1;directions[at]=3;}
        else if(next[j]>=current[j+1]){current[j]=next[j];directions[at]=1;}
        else{current[j]=current[j+1];directions[at]=2;}
      }
      [next,current]=[current,next];
    }
    let i=0,j=0;
    while(i<n&&j<m){
      const direction=directions[i*m+j];
      if(direction===3){same(a[prefix+i]);i++;j++;}
      else if(direction===1)del(a[prefix+i++]);
      else add(b[prefix+j++]);
    }
    while(i<n)del(a[prefix+i++]);
    while(j<m)add(b[prefix+j++]);
  }
  for(let i=a.length-suffix;i<a.length;i++)same(a[i]);
  return{lines,mode,added,removed};
}
export function diffLines(left:string,right:string):DiffLine[]{return buildLineDiff(left,right).lines;}

/** Fold only unchanged context, retaining context around changes near EOF. */
export function compactDiff(lines:readonly DiffLine[]):Array<DiffLine|{type:'gap';text:string}>{
  const result:Array<DiffLine|{type:'gap';text:string}>=[];
  for(let i=0;i<lines.length;){
    if(lines[i].type!=='same'){result.push(lines[i++]);continue;}
    let end=i;while(end<lines.length&&lines[end].type==='same')end++;
    if(end-i<=12)result.push(...lines.slice(i,end));
    else result.push(...lines.slice(i,i+3),{type:'gap',text:`省略 ${end-i-6} 行未改动内容`},...lines.slice(end-3,end));
    i=end;
  }
  return result;
}
