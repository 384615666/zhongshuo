import { z } from 'zod';

const RESERVED_WINDOWS_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A model-authored document is optional; null is the normal short-reply path. */
export function isSafeDocumentFilename(filename: string): boolean {
  if (filename.length === 0 || filename.length > 120 || filename !== filename.trim()) return false;
  if (!/\.md$/i.test(filename)) return false;
  if (/[\\/:*?"<>|]/.test(filename)) return false;
  if ([...filename].some((char) => char.charCodeAt(0) < 32)) return false;
  const stem = filename.slice(0, -3);
  if (stem.length === 0 || /[. ]$/.test(stem) || RESERVED_WINDOWS_STEM.test(stem)) return false;
  return filename !== '.' && filename !== '..';
}

export const documentSchema = z.strictObject({
  /** Business-facing basename only; never a path. */
  filename: z.string().refine(isSafeDocumentFilename, '文档文件名必须是安全的 .md basename'),
  /** Why this document is useful to the user. */
  purpose: z.string().min(1),
  /** Exact model-authored Markdown bytes; empty means no attachment. */
  markdown: z.string(),
});

export type DocumentArtifact = z.infer<typeof documentSchema>;
