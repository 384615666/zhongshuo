/** Projection of a runtime control result, never a transformation of human text.
 * Raw result remains in the message envelope and delivery/run evidence. */
export function chatAnswer(text:string,authorType:string):string {
  if(authorType!=='agent')return text;
  try {
    const value=JSON.parse(text) as Record<string,unknown>;
    const fields=['schemaVersion','resultKey','changeSummary','answer','responseKind','files','executedVerifications','unexecutedVerifications','remainingIssues'];
    if(!value || value.schemaVersion!=='task-complete-v1' || typeof value.resultKey!=='string' || typeof value.changeSummary!=='string' || !['files','executedVerifications','unexecutedVerifications','remainingIssues'].every(key=>Array.isArray(value[key])) || Object.keys(value).some(key=>!fields.includes(key)))return text;
    return typeof value.answer==='string'&&value.answer.trim()?value.answer:value.changeSummary;
  } catch {return text;}
}
