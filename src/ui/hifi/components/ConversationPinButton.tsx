import {navigationPinKey,type NavigationPinTarget} from '../../../contracts/navigationPins';
import {setConversationPinned} from '../data/navigationPins';
import {useStore} from '../data/store';
import {Icon} from './Icon';

export function ConversationPinButton({target,label,disabled=false}:{target:NavigationPinTarget;label:string;disabled?:boolean}){
  const key=navigationPinKey(target);
  const pinned=useStore(state=>state.navigationPins.some(pin=>navigationPinKey(pin)===key));
  const busy=useStore(state=>state.navigationPinBusy[key]===true);
  if(disabled&&!pinned)return null;
  const action=pinned?'取消置顶':target.kind==='room'?'置顶房间':'置顶私信';
  return <button className={`conversation-pin side-row-act${pinned?' is-pinned':''}`} data-zs-pin-toggle={key}
    title={`${action}「${label}」`} aria-label={`${action}「${label}」`} aria-pressed={pinned}
    disabled={busy} onClick={event=>{event.stopPropagation();void setConversationPinned(target,!pinned);}}><Icon name="pin" size={14}/></button>;
}
