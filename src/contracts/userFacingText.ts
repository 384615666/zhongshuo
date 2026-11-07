/** Presentation for program-generated status and errors only. Never apply this
 * to user/AI messages, files, tool output, or raw diagnostic payloads. */
export function userFacingSystemText(value:string):string {
  if (/请求超时[（(]\d+ms[）)]\s*[：:]\s*app\.settings\.get\s*$/.test(value)) return '读取设置超时，请稍后重试。';
  if(/reply was never sent|IPC.*(?:timeout|timed out)|command.*timed out/i.test(value))return '发送结果尚未确认，请稍后检查；使用原发送记录重试，避免重复发送。';
  if(/SQLITE_READONLY|readonly database/i.test(value))return '数据目录无法写入，请检查磁盘和目录权限后重试。';
  if(/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed/i.test(value))return '数据文件损坏，请保留整个数据目录并从完整备份恢复。';
  if(/SQLITE_BUSY|database is locked/i.test(value))return '数据正在被占用，请稍后重试。';
  if(/SQLITE_FULL|ENOSPC|disk is full/i.test(value))return '磁盘空间不足，请释放空间后重试。';
  if(/ENOENT/.test(value))return '目标文件或文件夹不可用，请重新选择位置。';
  if(/EINVAL/.test(value))return '文件名或目标路径无效，请重新选择保存位置。';
  if(/EPERM|EACCES/.test(value))return '没有权限访问目标位置，请选择可读写的文件夹。';
  if(/Too big: expected string to have <=(\d+) characters/i.test(value)) {
    const limit=/<=([0-9]+)/.exec(value)?.[1];
    return `输入内容超过 ${limit} 字符上限，请缩短后重试。`;
  }
  if (/源执行[\s\S]*恢复派发已完成/.test(value)) return '这次继续请求已处理，请刷新查看任务的最新进展。';
  if (/该任务已有在途恢复派发/.test(value)) return '已有继续请求在处理中，请稍候查看任务进展。';
  if (/protection_state\s*=\s*['"]?retained\b/i.test(value)) return '上次执行尚未确认结束。请点击“检查中断”查看具体成员和程序检查结果，解除占用后再继续。';
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
