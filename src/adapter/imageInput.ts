import { createHash } from 'node:crypto';
import { AdapterCallError } from '../contracts/runtime.ts';
import type { TurnRequest } from '../contracts/runtime.ts';

/** Byte-bearing input only. A filename/path cannot certify or substitute for image content. */
export function validatedImages(input: TurnRequest) {
  const images = input.images ?? [];
  let bytes = 0;
  for (const image of images) {
    const raw = Buffer.from(image.dataBase64, 'base64');
    const mime = raw.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : raw[0] === 255 && raw[1] === 216 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(raw.subarray(0, 6).toString('ascii')) ? 'image/gif'
      : raw.subarray(0, 4).toString('ascii') === 'RIFF' && raw.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
    bytes += raw.length;
    if (raw.length > 8 * 1024 * 1024 || bytes > 24 * 1024 * 1024 || mime !== image.mime || createHash('sha256').update(raw).digest('hex') !== image.hash) {
      throw new AdapterCallError('VALIDATION_INVALID', '图片输入字节、格式、容量或 hash 校验失败');
    }
  }
  if (input.text.trim().length === 0 && images.length === 0) throw new AdapterCallError('VALIDATION_INVALID', '模型输入为空');
  return images;
}

export function codexInput(input: TurnRequest) {
  const images = validatedImages(input);
  return [
    ...(input.text.length > 0 ? [{ type: 'text' as const, text: input.text, text_elements: [] }] : []),
    ...images.map((image) => ({ type: 'image' as const, url: `data:${image.mime};base64,${image.dataBase64}` })),
  ];
}

export function claudeInput(input: TurnRequest): { stream: boolean; stdin: string } {
  const images = validatedImages(input);
  if (images.length === 0) return { stream: false, stdin: input.text };
  return { stream: true, stdin: JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: [
      ...(input.text.length > 0 ? [{ type: 'text', text: input.text }] : []),
      ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.dataBase64 } })),
    ] } }) + '\n' };
}
