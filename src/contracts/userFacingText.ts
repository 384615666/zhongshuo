/** Presentation for program-generated status and errors only. Never apply this
 * to user/AI messages, files, tool output, or raw diagnostic payloads.
 *
 * R191 用户口径（2026-11-07）：提示里不出现英文技术标识——错误码、命令名、
 * 参数名、枚举值、HEAD/diff/CLI 等一律转为中文或去掉；括号及括号里的说明
 * 也全部去掉。产品名（Git、AI、PDF、Word、Office、Markdown、HTML、DOCX、
 * GitHub、渠道名等）保留。文件路径、文件名与网址不参与英文清理。 */
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

  // 路径、文件名、网址先占位保护，避免下面的英文清理误伤真实路径。
  const guarded:string[]=[];
  const guard=(text:string,pattern:RegExp)=>text.replace(pattern,(match)=>{guarded.push(match);return `\uE000${guarded.length-1}\uE000`;});
  let text=value;
  text=guard(text,/[A-Za-z]:[\\/][^\s，。；：、（）()"'<>|]+/g);
  text=guard(text,/(?:https?:\/\/|\\\\|\.{1,2}[\\/]|(?<![\w.])[\\/])[^\s，。；：、（）()"'<>|]+/g);
  text=guard(text,/\b[\w-]+\.(?:md|markdown|txt|json|csv|log|tsx?|jsx?|mjs|cjs|html?|css|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|yml|yaml|toml|ini|cfg|ps1|bat|cmd|sh|py|go|java|cpp?|h|cs|rs|rb|php|swift|kt|sql)\b/gi);
  text=guard(text,/\b(?:run|turn|task|thread|member|project|room|msg|cmd|ev|tool|art|iss|clm|del|chg|req|op|job)[-_][A-Za-z0-9_-]+\b/g);

  // 去掉 Electron/传输层包装。
  text=text.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,'').replace(/^Error:\s*/,'');

  // 错误码：开头的码连同冒号一起去掉；句中带下划线的码也去掉。
  text=text.replace(/^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|ERROR)\s*[:：]\s*/,'');
  text=text.replace(/([：:；;，,。！!\s])(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*[:：]\s*/g,'$1');
  text=text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,'');

  // 命令名（含紧随其后的英文动词，如 project.lifecycle unarchive）。
  text=text.replace(/\b(?:app|project|room|member|memberTemplate|task|turn|run|message|thread|dm|git|recovery|search|saved|settings|delivery|attachment|reminder|navigation|coordination|preview|document|image|changeset|runtimeCatalog)\.[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*(?:\s+[a-z][A-Za-z]*)?/g,'');
  // 参数赋值与英文比较表达式。
  text=text.replace(/\b(?:[a-z][A-Za-z0-9_]*|[A-Z][A-Z0-9_]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s，。；：、（）()]+)/g,'');
  text=text.replace(/\b[a-z][A-Za-z0-9]*\s*(?:<=|>=|<|>)\s*[a-z][A-Za-z0-9]*\b/g,'');

  // 已知状态/阶段/枚举。
  const stages:Record<string,string>={
    INDEPENDENT:'独立分析',CROSS_REVIEW:'互评',ISSUE_DISCUSSION:'讨论',SYNTHESIS:'整合',RATIFY:'确认',
    PREPARE:'准备',PUBLISH:'发布',DELIBERATE:'多人研讨',DIRECT:'单人执行',AUTO:'自动协作',
    UNKNOWN:'结果待确认',FAILED:'失败',PENDING:'等待中',RUNNING:'运行中',ACTIVE:'执行中',
    CANCELLED:'已取消',BLOCKED:'受阻',DONE:'已完成',REVIEW:'待验收',STOPPING:'停止中',
    INTERRUPTED:'已中断',SUCCEEDED:'已完成',QUEUED:'排队中',WAITING_USER:'待你处理',
    WAITING_APPROVAL:'等待批准',OPEN:'待开始',ERROR:'错误',
  };
  text=text.replace(/\b[A-Z][A-Z0-9_]*\b/g,key=>stages[key]??key);

  // 常见技术词与标识（长的先替换）。
  const words:Array<[RegExp,string]>= [
    [/\bfake runtime\b/gi,'模拟渠道'],
    [/\bprojectId\b/g,'项目编号'],[/\bthreadId\b/g,'回复串编号'],[/\bconversationId\b/g,'会话编号'],
    [/\bcommandId\b/g,'请求编号'],[/\bthroughMessageSeq\b/g,'已读水位'],[/\blineFrom\b/g,'起始行'],
    [/\blineTo\b/g,'结束行'],[/\bmaxTurns\b/g,'最大轮次'],[/\bexpectedRevision\b/g,'期望版本号'],
    [/\bschemaVersion\b/g,'结构版本'],[/\busedCalls\b/g,'已用调用数'],[/\binFlightCalls\b/g,'在途调用数'],
    [/\bnotStarted\b/g,'未开始'],[/\bkeepUnknown\b/g,'保留结果待确认'],[/\bmanualRiskAck\b/g,'人工风险确认'],
    [/\boperationPending\b/g,'操作待确认'],[/\boperationKnownRejected\b/g,'操作已明确拒绝'],
    [/\bsourceRunId\b/g,'来源运行编号'],[/\bdispatchKey\b/g,'派发标识'],[/\bturnId\b/g,'轮次编号'],
    [/\brunId\b/g,'运行编号'],[/\btaskId\b/g,'任务编号'],[/\bmemberId\b/g,'成员编号'],
    [/\broomId\b/g,'房间编号'],[/\battachmentId\b/g,'附件编号'],[/\bresourceId\b/g,'资源编号'],
    [/\bexpectedHead\b/g,'期望提交'],[/\bcommitOid\b/g,'提交编号'],[/\bownerMemberId\b/g,'负责成员编号'],
    [/\bworkspace-write\b/gi,'项目范围写入'],[/\bfail-closed\b/gi,'失败即拒绝'],[/\bno-op\b/gi,'空操作'],
    [/\btrue\/false\b/gi,'开或关'],[/\bmanual-claim\b/gi,'人工'],[/\bSHA-256\b/g,'证书指纹'],
    [/\bhttps?\(s\)?\b/gi,'网址'],[/\bhttps?\b/gi,'网址'],[/\bkey\b/gi,'键'],
    [/\bUTF-8\b/g,'通用文本编码'],[/\bHH:mm\b/g,'时:分'],[/\bIANA\b/g,'国际'],[/\bUTC\b/g,'协调世界时'],
    [/\bISO\b/g,'标准'],[/\bCA\b/g,'信任根'],[/\bSVG\b/g,'矢量图'],[/\bREADME\b/g,'说明文档'],
    [/\bprobeProcess\b/g,'进程核对'],[/\breleaseProtection\b/g,'解除保护'],[/\bappDataDir\b/g,'应用数据目录'],
    [/\bopenPath\b/g,'打开路径'],[/\bexited\b/gi,'已退出'],
    [/\bactive\b/gi,'启用中'],[/\bpending\b/gi,'等待中'],[/\bfailed\b/gi,'失败'],[/\brunning\b/gi,'运行中'],
    [/\bcancelled\b/gi,'已取消'],[/\bblocked\b/gi,'受阻'],[/\bdone\b/gi,'已完成'],[/\bundefined\b/gi,'未提供'],
    [/\bunavailable\b/gi,'不可用'],[/\bafter one turn\b/gi,'一轮后'],[/\bhistory\b/gi,'历史'],
    [/\btrue\b/gi,'是'],[/\bfalse\b/gi,'否'],
    [/\bruntime\b/gi,'运行渠道'],[/\bdaemon\b/gi,'后台服务'],[/\bprovider\b/gi,'服务商'],
    [/\btokens\b/gi,'词元'],[/\btoken\b/gi,'词元'],[/\bhash\b/gi,'哈希'],[/\boutbox\b/gi,'发件箱'],
    [/\bchangeset\b/gi,'改动集'],[/\bmanifest\b/gi,'清单'],[/\baudience\b/gi,'可见范围'],
    [/\brevision\b/gi,'版本号'],[/\bowner\b/gi,'负责人'],[/\bagent\b/gi,'AI 成员'],
    [/\bthread\b/gi,'回复串'],[/\broom\b/gi,'房间'],[/\btask\b/gi,'任务'],[/\bproject\b/gi,'项目'],
    [/\bturn\b/gi,'轮次'],[/\brun\b/gi,'运行'],[/\bjob\b/gi,'任务'],[/\bevent\b/gi,'事件'],
    [/\btool\b/gi,'工具'],[/\bscope\b/gi,'范围'],[/\bhooks\b/gi,'钩子'],[/\bstash\b/gi,'暂存'],
    [/\bdiff\b/gi,'差异'],[/\bHEAD\b/g,'当前提交'],[/\bbase\b/gi,'共同祖先'],[/\bours\b/gi,'本方'],
    [/\btheirs\b/gi,'对方'],[/\bCLI\b/g,'命令行'],[/\bShell\b/g,'命令行'],[/\bPID\b/g,'进程号'],
    [/\bLAN\b/g,'局域网'],[/\bURL\b/g,'网址'],[/\bIP\b/g,'网络地址'],[/\bID\b/g,'编号'],
    [/\bKB\b/g,'千字节'],[/\bMB\b/g,'兆字节'],[/\bGB\b/g,'吉字节'],[/\bms\b/g,'毫秒'],
    [/\bexpired\b/gi,'已过期'],[/\brestricted\b/gi,'受限'],[/\bretained\b/gi,'保留'],
    [/\breleased\b/gi,'已释放'],[/\bunarchive\b/gi,'取消归档'],[/\brestore\b/gi,'恢复'],
    [/\brelocate\b/gi,'重新定位'],[/\bundo\b/gi,'撤销'],[/\bnull\b/gi,'空值'],
    [/\bclaude\b/gi,'Claude'],[/\bcodex\b/gi,'Codex'],
  ];
  text=text.replace(/全员无有效输入/g,'所有 AI 都未返回有效结果');
  for(const [pattern,replacement] of words) text=text.replace(pattern,replacement);

  // 旧版开发口径清理（保留 R119 既有行为）。
  text=text
    .replace(/(?:按|依据|根据)\s*§\s*\d+(?:[.-]\d+)*\s*/g,'')
    .replace(/§\s*\d+(?:[.-]\d+)*\s*/g,'')
    .replace(/不合成虚构研讨报告[。；]?/g,'')
    .replace(/；?不伪造进度[。；]?/g,'')
    .replace(/预加载桥不可用（window\.zs 缺失）——正式命令面无法访问/g,'应用连接不可用，请重新打开众说')
    .replace(/保留原信封/g,'保留本次发送记录')
    .replace(/同号幂等/g,'使用原发送记录重试');

  // 括号及括号里的说明全部去掉（含嵌套与中英文括号）。
  let previous='';
  while(previous!==text){previous=text;text=text.replace(/（[^（）]*）/g,'').replace(/\([^()]*\)/g,'');}

  // 去掉替换后留下的多余标点与空白。
  text=text
    .replace(/[（(]\s*[）)]/g,'')
    .replace(/[{}]/g,'')
    .replace(/(?<=[\u4e00-\u9fff])\s*:\s*(?=[\u4e00-\u9fff])/g,'：')
    .replace(/([：；，、])\s+/g,'$1')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g,'')
    .replace(/\s+([，。；：、！？])/g,'$1')
    .replace(/([：；，、])\s*[；，、]/g,'$1')
    .replace(/([。！？])\s*[。！？]+/g,'$1')
    .replace(/([：:])\s*([。；，])/g,'$2')
    .replace(/——\s*$/,'')
    .replace(/^[\s；，、：:;,.]+|[\s；，、：:;,.]+$/g,'')
    .replace(/\s{2,}/g,' ')
    .trim();

  // 还原受保护的路径/文件名/网址。
  text=text.replace(/\uE000(\d+)\uE000/g,(_,index)=>guarded[Number(index)]??'');
  return text;
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
