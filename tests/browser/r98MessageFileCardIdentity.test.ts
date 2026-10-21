import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GeneratedFiles } from '../../src/ui/hifi/components/GeneratedFiles';
import { attachmentForChange } from '../../src/ui/hifi/components/MessageChangedFiles';
import type { MessageFileChange } from '../../src/contracts/messageFileChanges.ts';
import type { FormalAttachmentSummary } from '../../src/ui/hifi/data/types';

const file = (overrides: Partial<MessageFileChange> = {}): MessageFileChange => ({
  id: 'mfc_1', projectId: 'p1', conversationId: 'dm_1', taskId: 't2',
  changeSetId: 'cs_2', path: '方案.md', displayName: '方案.md', state: 'modified',
  declared: true, humanFacing: true, artifactId: 'art_gf_v2', revision: 2,
  sizeBytes: 12, addedLines: 2, removedLines: 1,
  beforeHash: 'old-hash', afterHash: 'same-content-hash', executionStatus: 'SUCCEEDED', createdAt: 2,
  ...overrides,
});

const hosted: FormalAttachmentSummary = {
  artifactId: 'art_detail_v2', filename: '方案.md', kind: 'text_file',
  hash: 'same-content-hash', sourcePath: '方案.md', revision: 1, document: true,
};
const real: FormalAttachmentSummary = {
  artifactId: 'art_gf_v2', filename: '方案.md', kind: 'text_file',
  hash: 'same-content-hash', sourcePath: '方案.md', revision: 2,
};

describe('R98 message file card identity', () => {
  it('selects the exact real change artifact even when hosted document is first', () => {
    expect(attachmentForChange(file(), [hosted, real])).toBe(real);
    const html = renderToStaticMarkup(createElement(GeneratedFiles, {
      attachments: [hosted, real], changes: [file()], onOpen: () => {},
    }));
    expect(html).toContain('data-zs-change-artifact-id="art_gf_v2"');
    expect(html).toContain('方案.md');
    expect(html).not.toContain('data-zs-artifact-id="art_detail_v2"');
  });

  it('does not merge a same-name/same-hash real file from a different path', () => {
    const other: FormalAttachmentSummary = { ...real, artifactId: 'art_gf_other', sourcePath: '另一目录/方案.md' };
    const html = renderToStaticMarkup(createElement(GeneratedFiles, {
      attachments: [other, real], changes: [file()], onOpen: () => {},
    }));
    expect(html).toContain('data-zs-artifact-id="art_gf_other"');
  });

  it('uses a strict source-path fallback only when the exact artifact id is absent', () => {
    const legacy = file({ artifactId: null });
    expect(attachmentForChange(legacy, [hosted, real])).toBe(real);
    const wrongPath: FormalAttachmentSummary = { ...real, sourcePath: '另一目录/方案.md' };
    const hostedWrongPath: FormalAttachmentSummary = { ...hosted, sourcePath: '另一目录/方案.md' };
    expect(attachmentForChange(legacy, [hostedWrongPath, wrongPath])).toBeUndefined();
  });
});
