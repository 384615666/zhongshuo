import {canonicalJson} from './common.ts';

export interface SendRequestReference {
  commandId:string;
  method:'message.submit';
  params:Record<string,unknown>;
  expectedRevision?:number|null;
}
export interface SendLookupRequest {request:SendRequestReference;payloadHash:string}
export interface RecoveredSendLocation {
  projectId:string;conversationId:string;roomId:string|null;threadId:string|null;
  messageId:string;taskId:string|null;
}
export type SendLookupResult=
  |{status:'found';commandId:string;payloadHash:string;location:RecoveredSendLocation;acceptedAt:number}
  |{status:'not-found'|'expired';commandId:string;payloadHash:string;message:string};

/** Exactly the wire representation hashed by the daemon; no credentials or UI labels. */
export function sendRequestCanonicalPayload(request:SendRequestReference):string {
  return canonicalJson({method:request.method,target:null,params:request.params,expectedRevision:request.expectedRevision??null});
}
export async function sendRequestPayloadHash(request:SendRequestReference):Promise<string>{
  const bytes=new TextEncoder().encode(sendRequestCanonicalPayload(request));
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
