/** Instructions belong to the selected channel, rather than a persistent banner. */
export function RuntimeChannelHelp({kind}: {kind: string}) {
  if (kind === 'pi') return <div className="field-hint" data-zs-runtime-channel-help={kind}>
    先安装官方 Pi CLI，并在 Pi 中配置 provider 和模型，众说沿用本机 Pi 配置。密钥由 Pi 管理，无需填入众说。默认执行程序为 pi；也可在高级设置填写其路径。当前仅使用 Pi 原生完整权限，项目受限和只读模式尚未认证。
  </div>;
  if (kind !== 'deepseek-harness') return null;
  return <div className="field-hint" data-zs-runtime-channel-help={kind}>
    先安装官方 DeepSeek Harness 和随包连接组件，在 DSH 的 zhongshuo 配置中设置模型。dsh web 使用另一份配置，不会自动同步。密钥由 DSH 管理；可在高级设置选择执行程序。当前使用原生完整权限。
  </div>;
}
