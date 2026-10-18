/** Projection of a runtime control result, never a transformation of human text.
 * Raw result remains in the message envelope and delivery/run evidence. */
import {taskCompleteSchema} from './taskComplete.ts';

export interface AppendedTaskComplete {
  controlText: string;
  visibleText: string;
  parsed: ReturnType<typeof taskCompleteSchema.parse>;
}

/** A model may append its validated control object after natural prose. A complete
 * TaskComplete object reaching the end of the text qualifies when its visible prefix ends
 * in whitespace/sentence punctuation; arbitrary/partial/internal JSON stays ordinary text. */
export function extractAppendedTaskComplete(text:string, expectedResultKey?:string):AppendedTaskComplete|null {
  let before=text.length;
  while(before>0){
    const index=text.lastIndexOf('{',before-1);
    if(index<0)return null;
    const visibleText=text.slice(0,index).trim();
    const controlText=text.slice(index).trim();
    if(visibleText.length>0&&(expectedResultKey!=null||/[。！？.!?\s]$/u.test(visibleText))){
      try{
        const parsed=taskCompleteSchema.safeParse(JSON.parse(controlText));
        if(parsed.success&&(expectedResultKey==null||parsed.data.resultKey===expectedResultKey)){
          return{controlText,visibleText,parsed:parsed.data};
        }
      }catch{
        // Try an earlier newline-prefixed object; incomplete tails remain untouched.
      }
    }
    before=index;
  }
  return null;
}

export function chatAnswer(text:string,authorType:string):string {
  if(authorType!=='agent')return text;
  try {
    const parsed=taskCompleteSchema.safeParse(JSON.parse(text));
    if(!parsed.success)return text;
    const value=parsed.data;
    return typeof value.answer==='string'&&value.answer.trim()?value.answer:value.changeSummary;
  } catch {
    return extractAppendedTaskComplete(text)?.visibleText??text;
  }
}
