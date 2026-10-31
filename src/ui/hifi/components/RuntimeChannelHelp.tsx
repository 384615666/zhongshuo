/** Instructions belong to the selected channel, rather than a persistent banner. */
export function RuntimeChannelHelp({kind}: {kind: string}) {
  if (kind === 'pi') return <div className="field-hint" data-zs-runtime-channel-help={kind}>
    先安装官方 Pi CLI，并在 Pi 中配置 provider 和模型，众说沿用本机 Pi 配置。密钥由 Pi 管理，无需填入众说。默认执行程序为 pi；也可在高级设置填写其路径。当前使用 Pi 原生完整权限；项目受限和只读模式尚未认证。模型清单与思考等级从本机渠道读取，列出或保存模型不代表已完成模型认证。
  </div>;
  if (kind !== 'deepseek-harness') return null;
  return <div className="field-hint" data-zs-runtime-channel-help={kind}>
    先安装官方 DeepSeek Harness，运行随包的 Harness 连接组件安装入口，再在 dsh web 配置模型。CLI 配置和密钥由 DSH 管理，无需把密钥填入众说。默认执行程序为 dsh；也可在高级设置填写其路径。当前使用 Harness 原生完整权限；项目受限和只读模式尚未认证。模型清单与思考等级从本机渠道读取，列出或保存模型不代表已完成模型认证。
  </div>;
}
