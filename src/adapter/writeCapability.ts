import {claudeLaunchIdentity,CLAUDE_PROJECT_WRITE_TOOL_ARGS} from './claude/cliAdapter.ts';
import {createHash} from 'node:crypto';
import certificate from './write-certification-r82.json' with {type:'json'};
export const CLAUDE_PROJECT_WRITE_POLICY_ID='claude-restricted-project-files-v1';
export const CLAUDE_PROJECT_WRITE_POLICY_HASH=createHash('sha256').update(JSON.stringify(CLAUDE_PROJECT_WRITE_TOOL_ARGS)).digest('hex');
/** Narrow real combination evidence. Configuration/program references do not manufacture support. */
export function fileWriteCapability(runtime:{kind:string|null;model:string|null;permissionMode:string|null;executable:string|null},cwd:string) {
  if(runtime.kind==='fake')return {status:'unsupported' as const,reason:'工程 Fake 不是实际工具认证'};
  if(runtime.kind!=='claude')return {status:'unverified' as const,reason:'当前渠道文件写入尚无真实认证；可改只读/仅记录，或换已验证的 Claude/glm-5.3-flash 成员'};
  if(runtime.model!==certificate.model || !certificate.permissionModes.includes(runtime.permissionMode??''))return {status:'unverified' as const,reason:runtime.model!==certificate.model?'模型不匹配（已验证 Claude/glm-5.3-flash）；可改只读/仅记录或换成员':'成员未选择项目文件编辑档；当前只读'};
  try {
    const identity=claudeLaunchIdentity({executable:runtime.executable??undefined,model:runtime.model??undefined,permissionMode:runtime.permissionMode as 'plan'},cwd);
    const reasons=[identity.reason,runtime.model!==certificate.model?'模型不匹配（已验证 glm-5.3-flash）':null,identity.executableHash!==certificate.executableHash?'执行程序字节与受限写入证据不匹配':null,identity.endpointHash!==certificate.endpointHash?'有效渠道与写入证据不匹配':null,!certificate.permissionModes.includes(runtime.permissionMode??'')?'成员未选择项目文件编辑档':null,certificate.policyId!==CLAUDE_PROJECT_WRITE_POLICY_ID||certificate.policyHash!==CLAUDE_PROJECT_WRITE_POLICY_HASH?'写入策略版本或参数不匹配':null].filter(Boolean);
    return {status:reasons.length?'unverified' as const:'supported' as const,reason:reasons.join('；')||'当前原生 CLI/渠道/模型文件策略有真实创建、编辑和越界拒绝证据；运行可用性仍以实际回执为准'};
  }catch{return {status:'unverified' as const,reason:'执行程序或有效配置不可读取；未开放文件写入'};}
}
