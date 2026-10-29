import {join} from 'node:path';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import type {ChangeSnapshot} from '../contracts/changeSnapshot.ts';
import {readStoredContent} from './preimage.ts';
interface Row {path:string;role:string;state:string;sha256:string|null;size:number|null;content_ref:string|null;content_unavailable:string|null;error:string|null}
/** Caller binds project/task and audience first. All changed paths;
 * content comes from immutable, hash-verified preimages, never the current worktree. */
export function readChangeSnapshot(db:ZhongshuoDatabase,appDataDir:string,projectId:string,taskId:string,changeSetId:string,filePath?:string):ChangeSnapshot {
  const cs=db.prepare('SELECT application_status FROM change_sets WHERE id=? AND project_id=? AND task_id=?').get(changeSetId,projectId,taskId) as {application_status:string};
  const paths=db.prepare(`SELECT path FROM change_set_files WHERE change_set_id=? GROUP BY path HAVING
    count(DISTINCT state)>1 OR count(DISTINCT sha256)>1 OR sum(CASE WHEN state='unknown' THEN 1 ELSE 0 END)>0
    OR count(*)=1 ORDER BY path`).all(changeSetId) as Array<{path:string}>;
  const files=paths.map(p=>{
    const r=db.prepare('SELECT * FROM change_set_files WHERE change_set_id=? AND path=?').all(changeSetId,p.path) as Row[];
    const b=r.find(x=>x.role==='before'),a=r.find(x=>x.role==='after');
    const change:ChangeSnapshot['files'][number]['change']=!b||!a||b.state==='unknown'||a.state==='unknown'?'unknown':b.state!=='present'&&a.state==='present'?'added':b.state==='present'&&a.state!=='present'?'removed':'modified';
    return{path:p.path,change,beforeHash:b?.sha256??null,afterHash:a?.sha256??null};
  });
  const result:ChangeSnapshot={projectId,taskId,changeSetId,applicationStatus:cs.application_status,files,truncated:false};
  if(filePath){
    const entries=db.prepare('SELECT * FROM change_set_files WHERE change_set_id=? AND path=?').all(changeSetId,filePath) as Row[];
    if(!entries.length)throw Error('文件不属于此改动集');
    const read=(row:Row|undefined)=>{
      if(!row)return{text:null,reason:'此侧快照尚未提供，不能推断空内容'};
      if(row.state==='absent')return{text:'',reason:'此侧确认不存在文件'};
      if(row.state!=='present'||!row.content_ref)return{text:null,reason:row.error??row.content_unavailable??'没有可读取的内容前像'};
      if(!/^[a-f0-9]{64}$/.test(row.content_ref))return{text:null,reason:'前像引用无效'};
      if(row.sha256!==row.content_ref)return{text:null,reason:'前像hash与内容引用不一致，未显示内容'};
      const store=join(appDataDir,'preimages',projectId);
      try {
        if(row.size==null)return{text:null,reason:'前像长度记录缺失'};
        const content=readStoredContent(store,row.content_ref);if(!content.ok)return{text:null,reason:content.error};
        if(content.content.length!==row.size)return{text:null,reason:'前像长度与记录不一致，未显示内容'};
        if(content.content.includes(0))return{text:null,reason:'二进制文件，可保存原件查看'};
        return{text:new TextDecoder('utf-8',{fatal:true}).decode(content.content),reason:null};
      }catch(e){return{text:null,reason:`前像读取失败：${(e as Error).message}`};}
    };
    result.content={path:filePath,before:read(entries.find(r=>r.role==='before')),after:read(entries.find(r=>r.role==='after'))};
  }
  return result;
}
