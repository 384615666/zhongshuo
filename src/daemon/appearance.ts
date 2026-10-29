/** Durable local avatar preferences. Images are stored as data URLs in
 * daemon_state, so a complete data-root copy carries them without temporary
 * absolute paths. No credential or remote URL is accepted. */
import type { ZhongshuoDatabase } from '../persistence/db.ts';

export interface AppearanceState {
  showAvatars: boolean;
  avatars: Record<string, string>;
}

const SHOW_KEY='appearance:show-avatars';
const AVATAR_PREFIX='appearance:avatar:';

function decodeImage(dataUrl:string):{mime:string;bytes:Buffer}|null{
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if(match==null)return null;
  const mime=`image/${match[1]}`;
  let bytes:Buffer;
  try{bytes=Buffer.from(match[2]!, 'base64');}catch{return null;}
  if(bytes.length===0)return null;
  const png=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const jpeg=bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  const webp=bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
  if((mime==='image/png'&&!png)||(mime==='image/jpeg'&&!jpeg)||(mime==='image/webp'&&!webp))return null;
  return{mime,bytes};
}

export function validAvatarSubject(db:ZhongshuoDatabase,subject:string):boolean{
  if(subject==='user')return true;
  const match=/^member:(m_[A-Za-z0-9_-]{1,120})$/.exec(subject);
  return match!=null&&db.prepare('SELECT 1 FROM project_members WHERE id=?').get(match[1]!)!=null;
}

export function readAppearance(db:ZhongshuoDatabase):AppearanceState{
  const rows=db.prepare("SELECT key,value FROM daemon_state WHERE key=? OR key LIKE ? ORDER BY key").all(SHOW_KEY,`${AVATAR_PREFIX}%`) as Array<{key:string;value:string}>;
  const avatars:Record<string,string>={};
  for(const row of rows){
    if(!row.key.startsWith(AVATAR_PREFIX))continue;
    const subject=row.key.slice(AVATAR_PREFIX.length);
    if(decodeImage(row.value)!=null)avatars[subject]=row.value;
  }
  return{showAvatars:rows.find(row=>row.key===SHOW_KEY)?.value!=='false',avatars};
}

export function writeShowAvatars(db:ZhongshuoDatabase,show:boolean,now=Date.now()):void{
  db.prepare('INSERT INTO daemon_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(SHOW_KEY,show?'true':'false',now);
}

export function writeAvatar(db:ZhongshuoDatabase,subject:string,dataUrl:string|null,now=Date.now()):void{
  if(!validAvatarSubject(db,subject))throw Error('头像对象不存在');
  if(dataUrl==null){
    db.prepare('DELETE FROM daemon_state WHERE key=?').run(`${AVATAR_PREFIX}${subject}`);
    return;
  }
  if(decodeImage(dataUrl)==null)throw Error('头像只接受有效的 PNG、JPEG 或 WebP 图片');
  db.prepare('INSERT INTO daemon_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(`${AVATAR_PREFIX}${subject}`,dataUrl,now);
}
