import type {DragEvent} from 'react';
import {useStore} from '../data/store';
import {navTaskStateOfRoom,roomUnread} from '../data/selectors';
import {openSidebarRoom} from '../loader';
import {Icon} from './Icon';
import {NavTaskMark,NavUnreadDot} from './NavMarks';
import {ConversationPinButton} from './ConversationPinButton';

/**
 * R183 第 1 项：侧栏房间行的拖动排序属性（由 App.tsx 组装，RoomNavItem 只负责挂到根节点）。
 * 置顶区（置顶房间 section）不传这一组属性，所以那些房间行不参与拖动。
 */
export interface RoomNavDrag {
  draggable: boolean;
  /** 拖动中 is-dragging / 落点 drop-before / drop-after */
  className: string;
  title: string;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: (event: DragEvent<HTMLDivElement>) => void;
}

export function RoomNavItem({projectId,roomId,name,active,projectName,drag}:{projectId:string;roomId:string;name:string;active:boolean;projectName?:string;drag?:RoomNavDrag}){
  const state=useStore(state=>state);
  const summary=navTaskStateOfRoom(state,roomId),unread=roomUnread(state,roomId);
  return <div className={`conversation-nav-row${drag?.className?` ${drag.className}`:''}`} data-zs-room-row={roomId}
    draggable={drag?.draggable||undefined} title={drag?.title}
    onDragStart={drag?.onDragStart} onDragOver={drag?.onDragOver} onDragLeave={drag?.onDragLeave}
    onDrop={drag?.onDrop} onDragEnd={drag?.onDragEnd}>
    <button className={`side-item${projectName?' pinned-conversation':' sub'}${active?' active':''}`} onClick={()=>{void openSidebarRoom(projectId,roomId);}}>
      {summary.state?<NavTaskMark summary={summary} where={name} size={12}/>:projectName?<Icon name="message-square" size={13}/>:<span className="side-icon-slot" aria-hidden="true"/>}
      <span className="conversation-nav-label"><span className="side-item-label" title={name}>{name}</span>{projectName?<span className="pin-project-label">{projectName}</span>:null}</span>
      <span className="side-marks"><NavUnreadDot count={unread} where={name}/></span>
    </button>
    <ConversationPinButton target={{kind:'room',projectId,itemId:roomId}} label={name}/>
  </div>;
}
