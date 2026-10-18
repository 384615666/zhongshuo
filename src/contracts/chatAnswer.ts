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
  const shape=findAppendedTaskCompleteShape(text,expectedResultKey==null);
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
  return findAppendedTaskCompleteShape(text,true)!=null;
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
  return extractAppendedTaskComplete(text,expectedResultKey)?.visibleText??text;
}
