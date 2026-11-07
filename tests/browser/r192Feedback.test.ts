import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GeneratedFiles } from '../../src/ui/hifi/components/GeneratedFiles';
import { MessageView } from '../../src/ui/hifi/components/MessageView';
import { savedItemMatchesText, type SavedItem } from '../../src/ui/hifi/LibraryPage';
import { SettingsPage } from '../../src/ui/hifi/pages/SettingsPage';
import type { FormalAttachmentSummary } from '../../src/ui/hifi/data/types';
import type { Message } from '../../src/ui/hifi/data/types';

const image: FormalAttachmentSummary = {
  artifactId: 'art_image', filename: 'image.png', kind: 'image_file', revision: 1, sizeBytes: 5120,
};
const document: FormalAttachmentSummary = {
  artifactId: 'art_doc', filename: '方案.md', kind: 'text_file', revision: 2, sizeBytes: 2048,
};

const saved = (overrides: Partial<SavedItem> = {}): SavedItem => ({
  kind: 'message', ref: 'msg_1', title: '读书会预算', projectId: 'p1', createdAt: 1,
  status: 'ok', locate: '#msg=msg_1', ...overrides,
});

describe('R192 message image previews', () => {
  it('renders an image attachment as a real thumbnail container instead of the fallback icon', () => {
    const html = renderToStaticMarkup(createElement(GeneratedFiles, {
      attachments: [image], changes: [], onOpen: () => {},
    }));
    expect(html).toContain('data-zs-attachment-thumb="loading"');
    expect(html).toContain('attachment-thumb-lg');
    expect(html).toContain('data-zs-image-preview-open="art_image"');
    expect(html).toContain('image.png');
    expect(html).toContain('打开');
  });

  it('keeps ordinary documents on the file icon without requesting an image thumbnail', () => {
    const html = renderToStaticMarkup(createElement(GeneratedFiles, {
      attachments: [document], changes: [], onOpen: () => {},
    }));
    expect(html).not.toContain('data-zs-attachment-thumb');
    expect(html).toContain('方案.md');
  });
});

describe('R192 saved favorites text search', () => {
  it('matches title, reference and kind text case-insensitively', () => {
    expect(savedItemMatchesText(saved(), '预算')).toBe(true);
    expect(savedItemMatchesText(saved({ title: 'Budget plan' }), 'budget')).toBe(true);
    expect(savedItemMatchesText(saved({ kind: 'link', ref: 'https://example.com/books' }), 'EXAMPLE.com/BOOKS')).toBe(true);
    expect(savedItemMatchesText(saved({ kind: 'task', title: null }), '任务')).toBe(true);
    expect(savedItemMatchesText(saved(), '不存在')).toBe(false);
    expect(savedItemMatchesText(saved(), '   ')).toBe(true);
  });
});

describe('R192 settings hide data operation and legacy draft import rows', () => {
  it('does not render the two hidden rows but keeps backup/restore', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { query: { section: 'data' } }));
    expect(html).not.toContain('最近一次数据操作');
    expect(html).not.toContain('从旧版本导入草稿');
    expect(html).not.toContain('data-zs-legacy-rescan');
    expect(html).toContain('备份全部数据');
    expect(html).toContain('使用已有数据或从备份恢复');
  });
});

describe('R192 message avatars in threads and DMs', () => {
  const message: Message = {
    id: 'msg_human', projectId: 'p1', roomId: 'r1', authorType: 'human', authorId: 'u1',
    kind: 'text', body: '你好', createdAt: 1,
  };
  it('renders the 50px avatar class in the shared message view', () => {
    const html = renderToStaticMarkup(createElement(MessageView, { message }));
    expect(html).toContain('avatar avatar-50');
  });
});
