import {runtimeExecutable,type RuntimeKind} from './runtimeKinds.ts';
/** A channel change invalidates provider-specific form choices. Permission is
 * intentionally absent: switching providers must not change the user's grant. */
export function runtimeChannelPatch(kind:RuntimeKind){
  return{kind,model:null,executable:runtimeExecutable(kind),effort:null};
}
