/**
 * 附件描述（正式侧 H1）：附件上传/共享预览属 H2。Composer 的 📎 会请求附件描述符——
 * 真实侧返回**明确标注未接通**的描述，且发送动作（loader.send*）拒绝携带附件的提交，
 * 不出现「附件看起来已附上」的 mock 成功。
 */
export interface AttachmentDescriptor { name: string; size: number; note: string }

export function mockAttachmentDescriptor(): AttachmentDescriptor {
  return { name: '', size: 0, note: '附件上传尚未接入正式链（H2）——本包只支持纯文本与仅记录发送' };
}
