import {command} from '../bridge';
import {getState,setState,toast} from './store';
import {navigationPinKey,type NavigationPin,type NavigationPinTarget} from '../../../contracts/navigationPins';
import {userFacingSystemText} from '../../../contracts/userFacingText';

let mutation=0;
export const navigationPinGeneration=()=>mutation;
export function applyNavigationPins(pins:NavigationPin[]|undefined,generation:number):void{
  if(!Array.isArray(pins)||generation!==mutation||Object.values(getState().navigationPinBusy).some(Boolean))return;
  setState(state=>({...state,navigationPins:pins}));
}
export async function setConversationPinned(target:NavigationPinTarget,pinned:boolean):Promise<void>{
  const key=navigationPinKey(target);
  if(getState().navigationPinBusy[key])return;
  mutation++;
  setState(state=>({...state,navigationPinBusy:{...state.navigationPinBusy,[key]:true}}));
  try{
    const result=await command<{pin:NavigationPin|null}>('navigation.pin',{clientId:'desktop-hifi',kind:target.kind,projectId:target.projectId,itemId:target.itemId,pinned});
    setState(state=>({...state,navigationPins:[...(result.pin?[result.pin]:[]),...state.navigationPins.filter(pin=>navigationPinKey(pin)!==key)]}));
  }catch(error){
    toast(`置顶操作未确认：${userFacingSystemText((error as Error).message)}，请重试`,'error');
  }finally{
    mutation++;
    setState(state=>({...state,navigationPinBusy:{...state.navigationPinBusy,[key]:false}}));
  }
}
