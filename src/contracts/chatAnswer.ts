/** Projection of a runtime control result, never a transformation of human text.
 * Raw result remains in the message envelope and delivery/run evidence. */
import {taskCompleteSchema} from './taskComplete.ts';
export function chatAnswer(text:string,authorType:string):string {
  if(authorType!=='agent')return text;
  try {
    const parsed=taskCompleteSchema.safeParse(JSON.parse(text));
    if(!parsed.success)return text;
    const value=parsed.data;
    return typeof value.answer==='string'&&value.answer.trim()?value.answer:value.changeSummary;
  } catch {return text;}
}
