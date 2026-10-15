/** Registry-wide archive reading. Independent of the renderer's focused-room
 * projection; bounded keyset pages, no project focus changes and no writes. */
import { z } from 'zod';
import type { ZhongshuoDatabase } from '../persistence/db.ts';

export const archiveListParams = z.strictObject({ projectId:z.string().min(1).optional(), limit:z.number().int().min(1).max(100).default(60), cursor:z.string().max(4096).optional() });
interface ArchiveRow {
  projectId:string; projectName:string; projectRevision:number; projectArchived:boolean;
  roomId:string|null; roomName:string|null; roomRevision:number|null; roomArchivedAt:number|null;
}
const cursorSchema=z.strictObject({v:z.literal(1),user:z.string(),scope:z.string(),project:z.string().min(1),room:z.string()});
export class ArchiveCursorError extends Error {}
export function readArchiveIndex(db:ZhongshuoDatabase,userId:string,params:z.infer<typeof archiveListParams>) {
  const scope=params.projectId??'*';let after:{project:string;room:string}|null=null;
  if(params.cursor){try{const c=cursorSchema.parse(JSON.parse(Buffer.from(params.cursor,'base64url').toString('utf8')));if(c.user!==userId||c.scope!==scope)throw Error('scope');after=c;}catch{throw new ArchiveCursorError('归档游标无效或属于其他读取范围，请重新读取');}}
  const rows=db.prepare(`WITH archive_rows AS (
    SELECT p.id projectId,p.display_name projectName,p.revision projectRevision,
      CASE WHEN p.status='archived' THEN 1 ELSE 0 END projectArchived,
      NULL roomId,NULL roomName,NULL roomRevision,NULL roomArchivedAt,'' roomKey
    FROM projects p WHERE p.status='archived'
    UNION ALL
    SELECT p.id,p.display_name,p.revision,CASE WHEN p.status='archived' THEN 1 ELSE 0 END,
      r.id,r.name,r.revision,r.archived_at,r.id
    FROM rooms r JOIN projects p ON p.id=r.project_id
    WHERE p.status<>'removed' AND (p.status='archived' OR r.archived_at IS NOT NULL)
  ) SELECT * FROM archive_rows
    WHERE (? IS NULL OR projectId=?)
      AND (? IS NULL OR projectId>? OR (projectId=? AND roomKey>?))
    ORDER BY projectId COLLATE BINARY,roomKey COLLATE BINARY LIMIT ?`).all(params.projectId??null,params.projectId??null,after?.project??null,after?.project??null,after?.project??null,after?.room??null,params.limit+1) as Array<Omit<ArchiveRow,'projectArchived'>&{projectArchived:number;roomKey:string}>;
  const hasMore=rows.length>params.limit,page=rows.slice(0,params.limit),tail=page.at(-1);
  return {items:page.map(r=>({projectId:r.projectId,projectName:r.projectName,projectRevision:r.projectRevision,projectArchived:r.projectArchived===1,roomId:r.roomId,roomName:r.roomName,roomRevision:r.roomRevision,roomArchivedAt:r.roomArchivedAt})),
    nextCursor:hasMore&&tail?Buffer.from(JSON.stringify({v:1,user:userId,scope,project:tail.projectId,room:tail.roomKey})).toString('base64url'):null,
    readAt:Date.now()};
}
