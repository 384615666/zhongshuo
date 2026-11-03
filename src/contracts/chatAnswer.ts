/** Projection of a runtime control result, never a transformation of human text.
 * Raw result remains in the message envelope and delivery/run evidence. */
import {TASK_COMPLETE_SCHEMA_VERSION,taskCompleteSchema} from './taskComplete.ts';

export interface AppendedTaskComplete {
  controlText: string;
  visibleText: string;
  parsed: ReturnType<typeof taskCompleteSchema.parse>;
}

interface AppendedTaskCompleteShape {
  controlText: string;
  visibleText: string;
  value: unknown;
}

function findFencedTaskCompleteShape(text:string):AppendedTaskCompleteShape|null {
  const blocks=[...text.matchAll(/^ {0,3}(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\1[ \t]*(?=\r?\n|$)/gim)];
  const controls:AppendedTaskCompleteShape[]=[];
  for(const block of blocks){
    const controlText=block[2]!.trim();
    try{
      const value:unknown=JSON.parse(controlText);
      if(isTaskCompleteShaped(value))controls.push({controlText,value,visibleText:[text.slice(0,block.index).trim(),text.slice(block.index!+block[0].length).trim()].filter(Boolean).join('\n\n')});
    }catch{/* Incomplete or ordinary code blocks remain visible. */}
  }
  // Multiple receipts are ambiguous; never select one by position.
  return controls.length===1?controls[0]!:null;
}

function isTaskCompleteShaped(value: unknown): boolean {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as {schemaVersion?:unknown}).schemaVersion === TASK_COMPLETE_SCHEMA_VERSION;
}

function findAppendedTaskCompleteShape(text:string,requireVisibleBoundary:boolean):AppendedTaskCompleteShape|null {
  let before=text.length;
  while(before>0){
    const index=text.lastIndexOf('{',before-1);
    if(index<0)return null;
    const rawVisibleText=text.slice(0,index);
    const visibleText=rawVisibleText.trim();
    const controlText=text.slice(index).trim();
    const hasVisibleBoundary=/[\s。！？.!?]$/u.test(rawVisibleText)
      || /[。！？.!?]$/u.test(visibleText);
    if(visibleText.length>0&&(!requireVisibleBoundary||hasVisibleBoundary)){
      try{
        const value:unknown=JSON.parse(controlText);
        if(isTaskCompleteShaped(value))return{controlText,visibleText,value};
      }catch{
        // Try an earlier newline-prefixed object; incomplete tails remain untouched.
      }
    }
    before=index;
  }
  return null;
}

/** A model may append its validated control object after natural prose. A complete
 * TaskComplete object reaching the end of the text is recognized by its control schema
 * marker. Without the caller's expected turn identity, a visible delimiter is still
 * required so directly concatenated ordinary JSON is not guessed away. */
export function extractAppendedTaskComplete(text:string, expectedResultKey?:string):AppendedTaskComplete|null {
  const fenced=findFencedTaskCompleteShape(text);
  // Mixed Markdown requires the current turn identity, so JSON examples in an
  // ordinary answer are preserved. A whole fenced receipt needs no prose guess.
  const shape=fenced&&(expectedResultKey!=null||!fenced.visibleText)
    ?fenced:findAppendedTaskCompleteShape(text,expectedResultKey==null);
  if(shape==null)return null;
  const parsed=taskCompleteSchema.safeParse(shape.value);
  if(!parsed.success||(expectedResultKey!=null&&parsed.data.resultKey!==expectedResultKey))return null;
  return{controlText:shape.controlText,visibleText:shape.visibleText,parsed:parsed.data};
}

/** True when terminal text itself presents a control object, even if its schema or
 * resultKey is invalid. Such explicit output must not be replaced by an earlier
 * message-completed cache from the same turn. */
export function isExplicitTaskCompleteOutput(text:string):boolean {
  try {
    if(isTaskCompleteShaped(JSON.parse(text.trim())))return true;
  } catch {
    // Mixed natural prose + control is checked below.
  }
  return findFencedTaskCompleteShape(text)!=null||findAppendedTaskCompleteShape(text,true)!=null;
}

export function chatAnswer(text:string,authorType:string,expectedResultKey?:string):string {
  if(authorType!=='agent')return text;
  try {
    const parsed=taskCompleteSchema.safeParse(JSON.parse(text));
    if(parsed.success&&(expectedResultKey==null||parsed.data.resultKey===expectedResultKey)){
      const value=parsed.data;
      return typeof value.answer==='string'&&value.answer.trim()?value.answer:value.changeSummary;
    }
  } catch { /* mixed/natural text is handled by the appended-control projection */ }
  const extracted=extractAppendedTaskComplete(text,expectedResultKey);
  return extracted?(extracted.visibleText||extracted.parsed.answer?.trim()||extracted.parsed.changeSummary):text;
}

function normalizedAnswerText(value:string):string {
  return value.trim().replace(/\s+/gu,' ').replace(/[。！？.!?]+$/u,'').trim();
}

function hasCompleteVisibleAnswer(visible:string,answer:string):boolean {
  const target=normalizedAnswerText(answer);
  if(!target)return false;
  if(normalizedAnswerText(visible)===target)return true;
  const flattenedVisible=visible.trim().replace(/\s+/gu,' ');
  const flattenedTarget=target.replace(/\s+/gu,' ');
  // A validated answer may be followed by an ordinary fenced example. Treat
  // the answer as complete only at a paragraph boundary; this avoids hiding
  // the short answer "是" inside "不是最终结论".
  const boundary=/[\s。！？.!?,，；;：:]/u;
  const afterStart=flattenedVisible.slice(flattenedTarget.length,flattenedTarget.length+1);
  const beforeEnd=flattenedVisible.slice(0,Math.max(0,flattenedVisible.length-flattenedTarget.length)).slice(-1);
  if(flattenedVisible.startsWith(flattenedTarget)&&boundary.test(afterStart))return true;
  if(flattenedVisible.endsWith(flattenedTarget)&&boundary.test(beforeEnd))return true;
  return visible
    .split(/(?:\r?\n)+|(?<=[。！？.!?])\s*/u)
    .map(normalizedAnswerText)
    .some((part)=>part===target);
}

/** Conversation replies may carry a short progress/status prefix followed by the
 * validated TaskComplete object. Keep that prefix, but never hide the actual answer
 * from the reply bubble. A separate control result is considered too because some
 * runtimes emit the readable message and the structured result as different fields. */
export function agentReplyText(text:string,controlResult?:string,expectedResultKey?:string):string {
  // Persisted envelopes already carry the validated receipt separately. Use
  // that identity when projecting older messages without rewriting their rows.
  if(expectedResultKey==null&&controlResult!=null){
    try{const parsed=taskCompleteSchema.safeParse(JSON.parse(controlResult));if(parsed.success)expectedResultKey=parsed.data.resultKey;}catch{/* No verified separate receipt. */}
  }
  const appended=extractAppendedTaskComplete(text,expectedResultKey)
    ??(controlResult!=null?extractAppendedTaskComplete(controlResult,expectedResultKey):null);
  const projectedControl=controlResult!=null?chatAnswer(controlResult,'agent',expectedResultKey):null;
  const answer=appended?.parsed.answer?.trim()
    ||(projectedControl!=null&&projectedControl!==controlResult?projectedControl.trim():undefined);
  const visible=chatAnswer(text,'agent',expectedResultKey).trim();
  if(!answer||hasCompleteVisibleAnswer(visible,answer))return visible||answer||text;
  return visible?`${visible}\n\n${answer}`:answer;
}
