import {describe,expect,it} from 'vitest';
import {openDatabase} from '../../src/persistence/db.ts';
import {readAppearance,writeAvatar,writeDefaultAvatar} from '../../src/daemon/appearance.ts';

const png=(byte:number)=>'data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10,byte]).toString('base64');
function fixture(){
  const db=openDatabase(':memory:');
  db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','p','C:/synthetic','C:/synthetic','{}',0)").run();
  db.prepare("INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('m_default_claude_p','p','Claude','agent',1)").run();
  return db;
}
describe('R159 automatic avatar correction',()=>{
  it('corrects an unmarked legacy image only when the originally read image still matches',()=>{
    const db=fixture(),subject='member:m_default_claude_p';
    try{
      db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,1)').run('appearance:avatar:'+subject,png(1));
      writeDefaultAvatar(db,subject,png(2),null);
      expect(readAppearance(db).avatars[subject]).toBe(png(1));
      writeDefaultAvatar(db,subject,png(2),png(1));
      expect(readAppearance(db).avatars[subject]).toBe(png(2));
    }finally{db.close();}
  });
  it('preserves a manual selection even when it equals the old automatic image',()=>{
    const db=fixture(),subject='member:m_default_claude_p';
    try{
      writeAvatar(db,subject,png(1));
      writeDefaultAvatar(db,subject,png(2),png(1));
      expect(readAppearance(db).avatars[subject]).toBe(png(1));
      writeAvatar(db,subject,null);
      writeDefaultAvatar(db,subject,png(2),null);
      expect(readAppearance(db).avatars[subject]).toBeUndefined();
    }finally{db.close();}
  });
});
