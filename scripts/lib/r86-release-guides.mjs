import { readFileSync,writeFileSync } from 'node:fs';
import { join,basename } from 'node:path';
import { createHash } from 'node:crypto';

export function writeR86ReleaseGuides(root){
  const build=JSON.parse(readFileSync(join(root,'ZhongshuoDual','BUILD.json'),'utf8')),version=basename(root);
  const daily=`# 众说 · 桌面多 AI 协作候选 ${version}

入口 start-desktop.bat；独立数据根为本目录 server-data。本包不带演示项目或默认 fake，不会在启动、重连或重开时自动调用模型。

## 组建与发起协作

1. 打开项目，在成员页配置真实渠道、准确模型 ID 和权限；房间设置选择协调成员，并保留本次允许参与的启用成员。相同名称仍是独立身份，短 ID 用来区分。
2. 如需人工验收，在发送任务前进入「项目设置 → 任务交付」，开启「任务交付后需要我确认」。新项目默认关闭；策略在任务创建时冻结，后来开启不会把已有自动交付任务变成待验收，普通对话也不因此变成验收任务。
3. 在房间不选 @ 直接发送自然任务：简单问题由协调成员直接回答；工作任务由协调成员提出可校验分工，正式派发给本房间获准成员，依次交接，最后整合交付。不需要你逐子任务点确认或复制材料。
4. 单选 @ 是定向执行；多选 @ 或 @全体是独立分析、互评、分歧与汇总的只读研讨。需要实际写文件的协作任务请交协调成员自动分工。
5. 打开原回复串的任务详情，查看真实分工、执行成员、等待/失败原因、步骤交接版本及成果。看板保留主任务，子任务从详情展开定位。
6. 停止主任务会约束排队步骤和在途后续派发，退出确认前不会冒充已停止。结果未知保留原请求与保护，不自动重发、换号或释放。
7. 对待验收交付先提交自然返工意见，再明确执行返工；验收绑定展示的指定版本。关窗重开保留原分工、版本、对话和阅读事实。

## 权限与预算

新执行配置默认 CLI 原生完整权限，可读写电脑并执行命令；显式只读保留，旧成员/模板不会自动提权。协作规划和评审按只读角色执行，实施与最终整合沿本次授权的成员配置；共享项目目录保持单写与版本交接。当前步骤串行，多个模型协作不等于并行写入。原生完整权限不是项目范围的操作系统沙箱。

AUTO 父任务默认共用最多24个调用格，规划、全部子任务、修复和整合合并计入，预留2次整合，最多8个分工步骤、12位候选成员，并服从更小的正式预算。预占/未知也占用。研讨按实际冻结人数推导有界预算，详情显示正式快照。失败保留已产生的真实文件和输入，不以无限互相唤醒解决失败。

普通续问由原成员直接回答；仅记录零调用。图片自动作为图片字节输入，保存/预览独立于模型是否能识别。旧图片手测与阅读器保留，不要求重跑历史清单。渠道不支持或实际失败会如实显示，不静默去图转文字。

## 已有数据与验证范围

先读 [完整升级说明](UPGRADE.md)。schema52仅追加协作状态，001–051冻结；不能把升级后的数据库塞回旧程序。用户正在使用的数据根未由工程自动复制、迁移或关闭。

BUILD ${build.buildId}，源码 ${build.commit}，clean=${!build.dirty}。见 ZhongshuoDual/BUILD.json、程序清单与 RELEASE-VALIDATION.json。配置保存、工程夹具、真实模型成功和用户体验验收分别记录；缺少同BUILD验证结果的候选仍待验，不凭本说明宣称成品。实际可用渠道组合以对应真实调用证据为准，不代表所有渠道已认证。

Android、安装器、签名、自动更新、多用户、外部人员通信、并行写入和既有无关延期未扩入。OS真实睡眠/断电、多日挂机与物理高DPI不由模拟结果代替。
`;
  const upgrade=`# 从旧版本完整保全升级

1. 正常关闭旧众说并等待关闭完成。未知发送保持未知，不为升级点击发送/重发。
2. 完整复制旧程序目录和整个 server-data 作为备份，包括浏览器 profile、草稿、未知账本、原件、数据库及伴随文件和根身份；不要只拷SQLite。
3. 取从未启动的新候选，将备份的整个 server-data 复制进去。新包已经使用则保留它，另取全新目录；不合并两个根，不同时运行继承同一身份的副本。
4. 只运行新目录 start-desktop.bat，核项目、成员、草稿和未知提示。新程序在升级schema51到52前另做数据库一致性备份；这不能代替第2步完整根备份。备份失败会拒绝升级。
5. 如需回退，正常关闭新包，再使用匹配的完整旧备份和旧程序。保留新根新增内容，不拆分新数据库供旧程序写入。旧程序应安全拒绝schema52。

工程验证仅使用自有完整根与副本，不操作你正在使用的旧根或旧包；迁移不搬项目文件、不自动派发/验收/对账/解除保护。
`;
  const candidate=`# 当前候选 · ${version}

主入口 [start-desktop.bat](start-desktop.bat)。BUILD ${build.buildId} / clean源码 ${build.commit}。

先读 [如何协作](README-DAILY.md) 与 [已有数据升级](UPGRADE.md)。同任务异构模型、工程负例及最终启动器结果以 RELEASE-VALIDATION.json 和交付证据索引为准；没有对应记录的构建仍待验证，不用阶段测试或旧包证据代替最终包。
`;
  const bodies=[['README-DAILY.md',daily],['README-CANDIDATE.md',candidate],['UPGRADE.md',upgrade],['UPGRADE-V23.md',upgrade]];
  for(const [file,text]of bodies)writeFileSync(join(root,file),text,'utf8');
  const files=bodies.map(([file])=>({file,sha256:createHash('sha256').update(readFileSync(join(root,file))).digest('hex')}));
  writeFileSync(join(root,'GUIDES-SHA256.json'),JSON.stringify({buildId:build.buildId,runtimeCommit:build.commit,scope:'R86 current external guides',files},null,2));
  return files;
}
