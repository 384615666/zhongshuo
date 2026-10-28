/**
 * 附件描述（正式侧 H1）：附件上传/共享预览属 H2。Composer 的 📎 会请求附件描述符——
 * 真实侧返回**明确标注未接通**的描述，且发送动作（loader.send*）拒绝携带附件的提交，
 * 不出现「附件看起来已附上」的 mock 成功。
 */
export interface AttachmentDescriptor { name: string; size: number; note: string }

/** 兼容原型调用形态（index 忽略）；正式侧 attach 按钮经 formalLimits 禁用，不产生该描述符。 */
export function mockAttachmentDescriptor(_index: number): AttachmentDescriptor {
  return { name: '', size: 0, note: '当前界面暂不支持上传附件' };
}
