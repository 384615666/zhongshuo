import {useRef,useState,type MouseEvent} from 'react';
import {navigationPinKey,type NavigationPinTarget} from '../../../contracts/navigationPins';
import {setConversationPinned} from '../data/navigationPins';
import {useStore} from '../data/store';
import {Icon} from './Icon';
import {Menu,MenuItem} from './ui';

/** Sibling controls keep the primary navigation button free of nested buttons. */
export function useConversationPinMenu(target:NavigationPinTarget,label:string,disabled=false){
  const key=navigationPinKey(target);
  const pinned=useStore(state=>state.navigationPins.some(pin=>navigationPinKey(pin)===key));
  const busy=useStore(state=>state.navigationPinBusy[key]===true);
  const [anchor,setAnchor]=useState<{x:number;y:number}|null>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const onContextMenu=(event:MouseEvent)=>{event.preventDefault();event.stopPropagation();setAnchor({x:event.clientX,y:event.clientY});};
  const menu=anchor?<Menu anchor={anchor} trigger={trigger.current} onClose={()=>setAnchor(null)}>
    <div className="menu-label">{label}</div>
    <MenuItem icon="pin" disabled={busy||(disabled&&!pinned)} onClick={()=>{setAnchor(null);void setConversationPinned(target,!pinned);}}>{pinned?'取消置顶':target.kind==='room'?'置顶房间':'置顶私信'}</MenuItem>
  </Menu>:null;
  const button=<button ref={trigger} className={`conversation-more side-row-act${anchor?' on':''}`} data-zs-pin-menu={key}
    title={`「${label}」的更多操作`} aria-label={`「${label}」的更多操作`} aria-haspopup="menu" aria-expanded={anchor!=null}
    disabled={busy} onClick={event=>{event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect();setAnchor(anchor?null:{x:rect.right,y:rect.bottom+4});}}><Icon name="more-horizontal" size={14}/></button>;
  return {onContextMenu,button,menu};
}
