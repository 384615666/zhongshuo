/** Shared labels for root attachments, message chips and delivery cards. */
export const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  text_file: '文本', code_file: '代码', image_file: '图片', pdf_file: 'PDF',
  docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯',
};

/** Unknown kinds use a readable fallback rather than an internal enum. */
export function attachmentKindLabel(kind: string): string {
  return ATTACHMENT_KIND_LABEL[kind] ?? '文件';
}
