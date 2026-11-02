import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import type {NavigationPin,NavigationPinTarget} from '../contracts/navigationPins.ts';
import {DaemonCommandError} from './commandError.ts';

const pinSchema=z.strictObject({kind:z.enum(['room','dm']),projectId:z.string().min(1),itemId:z.string().min(1),pinnedAt:z.number().finite().nonnegative()});
const keyOf=(viewer:string,client:string)=>'navigation:pins:'+createHash('sha256').update(JSON.stringify([viewer,client])).digest('hex');
function storedPins(db:ZhongshuoDatabase,viewer:string,client:string):Array<Omit<NavigationPin,'label'>>{
  const row=db.prepare('SELECT value FROM daemon_state WHERE key=?').get(keyOf(viewer,client)) as {value:string}|undefined;
  if(!row)return [];
  try{return z.array(pinSchema).max(500).parse(JSON.parse(row.value));}catch{return [];}
}
function labelOf(db:ZhongshuoDatabase,viewer:string,pin:NavigationPinTarget):string|null{
  const project=db.prepare("SELECT 1 FROM projects WHERE id=? AND status NOT IN ('archived','removed')").get(pin.projectId);
  if(!project)return null;
  if(pin.kind==='room'){
    return (db.prepare('SELECT name FROM rooms WHERE id=? AND project_id=? AND archived_at IS NULL').get(pin.itemId,pin.projectId) as {name:string}|undefined)?.name??null;
  }
  const row=db.prepare(`SELECT COALESCE(NULLIF(c.title,''),m.display_name,'成员') label FROM conversations c
    JOIN dm_participants self ON self.conversation_id=c.id AND self.project_id=c.project_id AND self.principal_type='human' AND self.principal_id=?
    LEFT JOIN dm_participants peer ON peer.conversation_id=c.id AND peer.project_id=c.project_id AND peer.principal_type='agent'
    LEFT JOIN project_members m ON m.id=peer.principal_id AND m.project_id=c.project_id
    WHERE c.id=? AND c.project_id=? AND c.kind='dm' AND c.archived_at IS NULL LIMIT 1`).get(viewer,pin.itemId,pin.projectId) as {label:string}|undefined;
  return row?.label??null;
}
export function readNavigationPins(db:ZhongshuoDatabase,viewer:string,client:string):NavigationPin[]{
  return storedPins(db,viewer,client).flatMap(pin=>{const label=labelOf(db,viewer,pin);return label==null?[]:[{...pin,label}];});
}
export function assertNavigationPinAvailable(db:ZhongshuoDatabase,viewer:string,target:NavigationPinTarget):void{
  if(labelOf(db,viewer,target)==null)throw new DaemonCommandError('RESOURCE_NOT_FOUND','房间或私信已不可用，无法置顶');
}
/** Called inside the command transaction. Only this shortcut changes; ordinary
 * navigation writes cannot replace pins, and independent pin actions compose. */
export function writeNavigationPin(db:ZhongshuoDatabase,viewer:string,client:string,target:NavigationPinTarget,pinned:boolean,now=Date.now()):NavigationPin|null{
  const pins=storedPins(db,viewer,client),same=(pin:NavigationPinTarget)=>pin.kind===target.kind&&pin.itemId===target.itemId;
  const existing=pins.find(same);
  const label=pinned?labelOf(db,viewer,target):null;
  if(pinned&&label==null)throw new DaemonCommandError('RESOURCE_NOT_FOUND','房间或私信已不可用，无法置顶');
  const pin=pinned?{kind:target.kind,projectId:target.projectId,itemId:target.itemId,label:label!,pinnedAt:existing?.pinnedAt??now}:null;
  const rest=pins.filter(item=>!same(item));
  if(pin&&rest.length>=500)throw new DaemonCommandError('VALIDATION_INVALID','置顶数量已达上限，请先取消一些置顶');
  const next=pin?[{kind:pin.kind,itemId:pin.itemId,projectId:pin.projectId,pinnedAt:pin.pinnedAt},...rest]:rest;
  db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(keyOf(viewer,client),JSON.stringify(next),now);
  return pin;
}
