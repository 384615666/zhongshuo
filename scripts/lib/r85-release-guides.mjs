import {readFileSync,writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
/** User-facing package guides describe current behavior, never accumulated
 * historical implementation notes. Program bytes and BUILD stay untouched. */
export function writeR85ReleaseGuides(root){
 const build=JSON.parse(readFileSync(join(root,'ZhongshuoDual/BUILD.json'),'utf8')),version=basename(root);
 const text=`# 众说日常桌面版 · ${version}

运行 start-desktop.bat；程序与数据在本目录，数据位于 server-data。首次使用从欢迎页打开自己的项目文件夹；本包不带演示项目或默认模拟成员。

## 沿用旧数据

正在使用v23时，先正常关闭并等待完成，再完整备份旧包及全部server-data。只向从未启动的新包复制整个server-data，不能只拷SQLite，也不能合并两个使用中的根。详见 [完整升级步骤](UPGRADE-V23.md)。不要同时运行两个继承同一数据身份的副本。

## 当前日常行为

- 执行成员的新配置默认与CLI完整权限一致，可以读写整个电脑并运行命令。需要限制时显式选择只读；旧成员和已有模板不会被自动改权。项目范围授权只管理对应的范围模式，不会把完整权限偷偷限制回旧白名单。
- 普通发送默认请求AI；只有附件或只有图片也可发送。图片自动按实际渠道传入模型，不需要手选工程认证资格。渠道明确不支持或请求失败会说明原因；本地预览和“仅记录”独立可用，不静默去图转文字。
- 同一回复串普通续问由原执行成员回答；“仅记录”只保存。需要重新改交付时先记录返工意见，再明确执行返工；验收绑定具体版本。
- 结果未知保留原commandId和参数，重连/重开不自动发送。需要时只能人工同号同参重放，不能当成“肯定没执行”另建一次。
- 成员可改名/说明，从明确成员保存配置模板，再在明确项目创建独立成员。模板只影响后续创建，不复制凭据、会话、任务或项目授权。
- Git分别显示已暂存与工作区内容，支持首提交、明确创建/切换分支和软撤销。冲突需读到有效三方快照后明确提交；超限/非文本不当空覆盖。提交不执行Git hooks，需钩子的项目先在自己的Git工具检查。
- 归档按项目分页读取，搜索只筛选已读取内容；失败保留已确认清单，可就地重试。解除房间单独归档不会暗中恢复整体归档项目。看板筛选与返回路径、活动跨项目定位接真实身份。
- 帮助/设置里的本地诊断只读，复制默认脱敏，不会自动继续任务、对账、解除保护或联网提交资料。

## 版本与范围

BUILD ${build.buildId}，运行源码 ${build.commit}（clean=${!build.dirty}），详见 ZhongshuoDual/BUILD.json 与程序清单。当前schema51；本轮无新增迁移。

实际运行依赖本机CLI、成员模型与渠道。配置保存不代表所有渠道或工具已认证；工程成绩与用户日常验收分开。若附 RELEASE-VALIDATION.json，可核对其中相同BUILD的工程结果；没有对应结果的构建仍待验证。图片此前用户手测结果继承，不要求重跑历史清单。真实OS睡眠/断电、多日挂机和实体HiDPI不在本轮认证范围。

原型对照只用于界面参考，不把原型模拟数据放入本包。Android、安装器、签名、自动更新和既有延期未包含。
`;
 const upgrade=`# 从使用中的v23升级

1. 正常关闭旧众说并等待关闭完成，未知发送保持未知，不为升级点击重发。
2. 把整个旧v23文件夹完整复制成备份，含程序、整个server-data及其中的electron-user-data浏览器资料、原件、数据库伴随文件和根身份标记。不要只拷state.sqlite。
3. 准备一份从未启动的 ${version}，应尚无server-data。把备份内整个server-data复制到这里。若新包已使用，保留它，另取全新程序目录，不要混合两个根。
4. 只启动新目录的start-desktop.bat，核项目、成员、草稿与未知提示。项目仍指向原磁盘路径，升级不搬项目文件，也不自动重发或继续任务。
5. 需要回退时先正常关闭新包，再用匹配的完整旧备份及旧程序。新包期间新增数据仍在新根保留，不给旧程序塞入部分新数据，不同时开两个继承同一根身份的副本。

本轮无新增迁移，001–051冻结。工程只在自有完整副本验证升级/原未知信封/提及与附件/草稿/原件hash/匹配回退，未操作你的旧根。
`;
 const candidate=`# 当前候选 · ${version}

唯一入口 [start-desktop.bat](start-desktop.bat)。BUILD ${build.buildId} / clean运行源码 ${build.commit}。

先读 [日常使用](README-DAILY.md)，已有v23数据请读 [升级步骤](UPGRADE-V23.md)。该候选的程序清单与真实启动器、工作流、Git、跨项目读取、升级和真实GLM工程验证相绑定；历史rc/stage包保留，不作为当前入口。工程通过与用户验收分开。
`;
 for(const [name,body]of [['README-DAILY.md',text],['README-CANDIDATE.md',candidate],['UPGRADE-V23.md',upgrade]])writeFileSync(join(root,name),body,'utf8');
 const files=['README-DAILY.md','README-CANDIDATE.md','UPGRADE-V23.md'].map(file=>({file,sha256:createHash('sha256').update(readFileSync(join(root,file))).digest('hex')}));
 writeFileSync(join(root,'GUIDES-SHA256.json'),JSON.stringify({buildId:build.buildId,runtimeCommit:build.commit,scope:'external user guides only; not a rebuilt program',files},null,2));return files;
}
