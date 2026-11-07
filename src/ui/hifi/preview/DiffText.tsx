import {useEffect,useMemo,useState} from 'react';
import {Icon} from '../components/Icon';
import {buildLineDiff,compactDiff} from '../lib/textDiff';
export {diffLines} from '../lib/textDiff';

/** Empty strings are known empty versions. Only null/undefined means missing. */
export function DiffText({left,right,leftLabel,rightLabel}:{left:string|null|undefined;right:string|null|undefined;leftLabel:string;rightLabel:string}){
  const diff=useMemo(()=>left!=null&&right!=null?buildLineDiff(left,right):null,[left,right]);
  const rows=useMemo(()=>compactDiff(diff?.lines??[]),[diff]);
  const [limit,setLimit]=useState(500);
  useEffect(()=>setLimit(500),[diff]);
  if(diff==null||diff.mode==='large')return <div className="panel warning" data-zs-diff-fallback="1">
    <div className="panel-title"><Icon name="alert-triangle" size={13}/>{diff==null?'不具备完整比较内容':'文件较大，暂时分别展示修改前后内容'}</div>
    <div className="small faint">{diff==null?'缺少一侧的版本，已有内容保留在下方。':'下方仅展示内容开头；完整内容可下载原文件查看。'}</div>
    {[[leftLabel,left],[rightLabel,right]].map(([label,text],i)=>text!=null?<section key={i}><strong>{label}</strong><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{text.slice(0,64_000)}</pre>{text.length>64_000?<p>后续内容已省略。</p>:null}</section>:null)}
  </div>;
  return <div className="preview-diff">
    <div className="preview-diff-head">
      <span className="pill del"><Icon name="minus" size={10}/>{leftLabel}</span>
      <Icon name="arrow-right" size={12} className="faint"/>
      <span className="pill add"><Icon name="plus" size={10}/>{rightLabel}</span>
      <div className="spacer"/><span className="small faint">+{diff.added} / −{diff.removed} 行</span>
    </div>
    {diff.mode==='blocks'?<div className="small faint">改动较多，按整段标记新增与删除。</div>:null}
    {rows.length===0?<div className="small faint">两个版本均为空。</div>:null}
    <div className="preview-diff-body">{rows.slice(0,limit).map((line,i)=>line.type==='gap'
      ?<div key={i} className="small faint" style={{padding:'6px 12px'}}>{line.text}</div>
      :<div className={`preview-diff-row ${line.type}`} key={i}>
        <span className="preview-diff-no">{line.leftNo??''}</span><span className="preview-diff-no">{line.rightNo??''}</span>
        <span className="preview-diff-sign">{line.type==='add'?'+':line.type==='del'?'−':' '}</span>
        <span className="preview-diff-text">{line.text||' '}</span>
      </div>)}</div>
    {rows.length>limit?<button className="btn sm" onClick={()=>setLimit(value=>value+500)}>显示更多，还有 {rows.length-limit} 行</button>:null}
  </div>;
}
