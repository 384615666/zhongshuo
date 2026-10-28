/** Presentation for program-generated status and errors only. Never apply this
 * to user/AI messages, files, tool output, or raw diagnostic payloads. */
export function userFacingSystemText(value:string):string {
  let text=value
    .replace(/（[^（）]*(?:§\s*\d|(?:RT|DEV|AT|ADR)-\d|开工契约|终结规则)[^（）]*）/g,'')
    .replace(/\([^()]*(?:§\s*\d|(?:RT|DEV|AT|ADR)-\d|开工契约|终结规则)[^()]*\)/g,'')
    .replace(/(?:按|依据|根据)\s*§\s*\d+(?:[.-]\d+)*\s*/g,'')
    .replace(/全员无有效输入/g,'所有 AI 都未返回有效结果')
    .replace(/不合成虚构研讨报告[。；]?/g,'')
    .replace(/；?不伪造进度[。；]?/g,'')
    .replace(/预加载桥不可用（window\.zs 缺失）——正式命令面无法访问/g,'应用连接不可用，请重新打开众说')
    .replace(/保留原信封/g,'保留本次发送记录')
    .replace(/同号幂等/g,'使用原发送记录重试');
  const stages:Record<string,string>={
    INDEPENDENT:'独立分析',CROSS_REVIEW:'互评',ISSUE_DISCUSSION:'讨论',SYNTHESIS:'整合',RATIFY:'确认',
    PREPARE:'准备',PUBLISH:'发布',DELIBERATE:'多人研讨',DIRECT:'单人执行',AUTO:'自动协作',
  };
  text=text.replace(/(?<![\w/\\.-])(?:INDEPENDENT|CROSS_REVIEW|ISSUE_DISCUSSION|SYNTHESIS|RATIFY|PREPARE|PUBLISH|DELIBERATE|DIRECT|AUTO)(?![\w/\\.-])/g,key=>stages[key]!);
  return text.replace(/([：；，])\s*[；，]/g,'$1').replace(/^[；，\s]+|[；，\s]+$/g,'').trim();
}

/** Only these events carry a program-owned explanation. Other summaries can
 * contain a person's question, feedback or a tool result and stay verbatim. */
const SYSTEM_EXPLANATION_EVENTS=new Set([
  'task.contextAssemblyFailed','task.deliberationPrepareFailed','task.dispatchFailed',
  'turn.startupFailed','turn.failed','turn.dispatchFailed',
  'run.stageAdvanced','run.stageChanged','run.participantAbsent','run.dispatchWaitExceeded',
]);
export function userFacingSystemEventText(kind:string,value:string):string {
  if(SYSTEM_EXPLANATION_EVENTS.has(kind))return userFacingSystemText(value);
  if(['run.statusChanged','task.statusChanged'].includes(kind)
    && value.startsWith('全员无有效输入'))return userFacingSystemText(value);
  return value;
}
