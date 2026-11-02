import type { AppState, DmConversation } from '../data/types';

export function dmActivityAt(dm: DmConversation): number {
  return dm.lastReplyAt ?? (dm.lastMessageAt || dm.createdAt);
}

export function sortDmConversations(items: DmConversation[]): DmConversation[] {
  return [...items].sort((a,b)=>dmActivityAt(b)-dmActivityAt(a)||b.createdAt-a.createdAt||a.id.localeCompare(b.id));
}

export function visibleDmProjects(state: Pick<AppState,'projects'|'visibleProjectIds'|'pinnedProjectIds'>) {
  return [...new Set([...state.pinnedProjectIds,...state.visibleProjectIds])]
    .map(id=>state.projects.find(project=>project.id===id&&project.removedAt==null))
    .filter((project):project is AppState['projects'][number]=>project!=null);
}

/** Calendar dates in the user's local timezone, including across DST changes. */
export function dmListTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date=new Date(at),today=new Date(now);
  const day=(value:Date)=>Date.UTC(value.getFullYear(),value.getMonth(),value.getDate());
  const ago=(day(today)-day(date))/86_400_000;
  const pad=(value:number)=>String(value).padStart(2,'0');
  if(ago===0)return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if(ago===1)return '昨天';
  if(ago===2)return '前天';
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}
