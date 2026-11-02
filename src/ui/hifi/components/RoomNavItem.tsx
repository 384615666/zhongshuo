import {useStore} from '../data/store';
import {navTaskStateOfRoom,roomUnread} from '../data/selectors';
import {openSidebarRoom} from '../loader';
import {Icon} from './Icon';
import {NavTaskMark,NavUnreadDot} from './NavMarks';
import {useConversationPinMenu} from './ConversationPinMenu';

export function RoomNavItem({projectId,roomId,name,active,projectName}:{projectId:string;roomId:string;name:string;active:boolean;projectName?:string}){
  const state=useStore(state=>state);
  const summary=navTaskStateOfRoom(state,roomId),unread=roomUnread(state,roomId);
  const pin=useConversationPinMenu({kind:'room',projectId,itemId:roomId},name);
  return <div className="conversation-nav-row" data-zs-room-row={roomId} onContextMenu={pin.onContextMenu}>
    <button className={`side-item${projectName?' pinned-conversation':' sub'}${active?' active':''}`} onClick={()=>{void openSidebarRoom(projectId,roomId);}}>
      {summary.state?<NavTaskMark summary={summary} where={name} size={12}/>:projectName?<Icon name="message-square" size={13}/>:<span className="side-icon-slot" aria-hidden="true"/>}
      <span className="conversation-nav-label"><span className="side-item-label" title={name}>{name}</span>{projectName?<span className="pin-project-label">{projectName}</span>:null}</span>
      <span className="side-marks"><NavUnreadDot count={unread} where={name}/></span>
    </button>
    {pin.button}{pin.menu}
  </div>;
}
