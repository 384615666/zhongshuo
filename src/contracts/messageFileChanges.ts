/** Message-bound file facts, independent of whether an attachment can be opened. */
export interface MessageFileChange {
  id: string;
  projectId: string;
  conversationId: string;
  taskId: string;
  changeSetId: string | null;
  path: string;
  displayName: string;
  state: 'added' | 'modified' | 'removed' | 'unknown';
  declared: boolean;
  humanFacing: boolean;
  artifactId: string | null;
  revision: number | null;
  sizeBytes: number | null;
  addedLines: number | null;
  removedLines: number | null;
  beforeHash: string | null;
  afterHash: string | null;
  executionStatus: string;
  createdAt: number;
}

/** Delivery documents are prominent; internal instructions/logs stay in the full list. */
export function humanFacingFile(path: string, declared = false): boolean {
  const normalized = path.replaceAll('\\', '/');
  const leaf = normalized.split('/').at(-1) ?? normalized;
  if (/^(?:AGENTS|SKILL|CLAUDE|GEMINI)\.md$/i.test(leaf)) return false;
  if (!declared && /(?:^|\/)(?:node_modules|\.git|\.codex[^/]*|\.tmp[^/]*|tmp|temp|logs?|coverage)(?:\/|$)/i.test(normalized)) return false;
  return /\.(?:md|markdown|txt|pdf|docx|xlsx|xlsm|pptx|csv|tsv|html?|png|jpe?g|gif|webp|svg)$/i.test(leaf);
}
