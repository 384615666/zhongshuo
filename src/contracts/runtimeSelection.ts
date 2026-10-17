/** A channel change invalidates provider-specific form choices. Permission is
 * intentionally absent: switching providers must not change the user's grant. */
export function runtimeChannelPatch(kind:'claude'|'codex'|'fake'){
  return{kind,model:null,executable:kind,effort:null};
}
