import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {GeneratedFiles} from '../../src/ui/hifi/components/GeneratedFiles';
import type {FormalAttachmentSummary} from '../../src/ui/hifi/data/types';
import type {MessageFileChange} from '../../src/contracts/messageFileChanges';

const document: FormalAttachmentSummary = {
  artifactId: 'doc_v5', filename: '方案.md', kind: 'text_file', document: true,
  revision: 5, hash: 'current', sourcePath: '方案.md', sizeBytes: 20480,
  purpose: '业务确认与开发排期',
};
const change: MessageFileChange = {
  id: 'change', projectId: 'p', conversationId: 'c', taskId: 't',
  changeSetId: 'cs', path: '方案.md', displayName: '方案.md', state: 'modified',
  declared: true, humanFacing: true, artifactId: 'generated_v1', revision: 1,
  sizeBytes: 20480, addedLines: 2, removedLines: 1, beforeHash: 'old', afterHash: 'current',
  executionStatus: 'SUCCEEDED', createdAt: 1,
};
const render = (attachments: FormalAttachmentSummary[], changes: MessageFileChange[] = [], nonFinal = false) =>
  renderToStaticMarkup(createElement(GeneratedFiles, {attachments, changes, nonFinal, onOpen: () => {}}));

describe('R102 unified readable delivery cards', () => {
  it('renders hosted documents as full cards without inventing a change or a diff', () => {
    const html = render([document]);
    expect(html).toContain('class="message-document-card"');
    expect(html).toContain('data-zs-artifact-id="doc_v5"');
    expect(html).toContain('业务确认与开发排期');
    expect(html).toContain('v5');
    expect(html).toContain('20 KB');
    expect(html).toContain('打开');
    expect(html).not.toContain('查看变更');
    expect(html).not.toContain('个文件涉及本轮工作');
  });

  it('preserves actual changes and diff access under the preferred v5 document identity', () => {
    const generated = {...document, artifactId: 'generated_v1', document: false, revision: 1};
    const html = render([document, generated], [change]);
    expect(html).toContain('data-zs-artifact-id="doc_v5"');
    expect(html).not.toContain('data-zs-artifact-id="generated_v1"');
    expect(html).not.toContain('data-zs-change-artifact-id="generated_v1"');
    expect(html).toContain('1 个文件涉及本轮工作');
    expect(html).toContain('查看变更');
    expect(html).toContain('+2');
  });

  it('shows unknown declared files without treating an unrelated changeset as a diff', () => {
    const html = render([{...document, artifactId: 'generated_v1', document: false}],
      [{...change, state: 'unknown', beforeHash: null}]);
    expect(html).toContain('class="message-document-card"');
    expect(html).toContain('相关文件');
    expect(html).not.toContain('查看变更');
  });

  it('gives ordinary readable attachments the same full card and non-final marker', () => {
    const html = render([{...document, document: false}], [], true);
    expect(html).toContain('class="message-document-card"');
    expect(html).toContain('data-zs-non-final-file="1"');
    expect(html).not.toContain('查看变更');
  });

  it.each([1, 5])('does not let a pathless v%s document claim two same-content files and their diffs', revision => {
    const hosted = {...document, revision, sourcePath: undefined};
    const files = ['a', 'b'].map(directory => ({
      ...document, artifactId: `generated_${directory}`, document: false,
      sourcePath: `${directory}/方案.md`, revision: 1,
    }));
    const changes = files.map((file, index) => ({
      ...change, id: `change_${index}`, path: file.sourcePath,
      artifactId: file.artifactId, changeSetId: `cs_${index}`,
    }));
    const html = render([hosted, ...files], changes);
    expect(html.match(/class="message-document-card"/g)).toHaveLength(3);
    expect(html).toContain('data-zs-artifact-id="doc_v5"');
    for (const file of files) {
      expect(html).toContain(`data-zs-artifact-id="${file.artifactId}"`);
      expect(html).toContain(`data-zs-change-artifact-id="${file.artifactId}"`);
    }
    // Hosted card ends before the first independently identified file card.
    const hostedCard = html.slice(html.indexOf('data-zs-artifact-id="doc_v5"'), html.indexOf('data-zs-document-change='));
    expect(hostedCard).not.toContain('查看变更');
    expect(hostedCard).not.toContain('已更新');
    expect(html).toContain('2 个文件涉及本轮工作');
    expect(html.match(/查看变更/g)).toHaveLength(4); // one per real card and list row
  });

  it('allows a pathless v5 document to own one uniquely proven file and its actual diff', () => {
    const file = {...document, artifactId: 'generated_v1', revision: 1, document: false};
    const html = render([{...document, sourcePath: undefined}, file], [change]);
    expect(html.match(/class="message-document-card"/g)).toHaveLength(1);
    expect(html).toContain('data-zs-artifact-id="doc_v5"');
    expect(html).not.toContain('data-zs-change-artifact-id="generated_v1"');
    expect(html).toContain('查看变更');
    expect(html).toContain('1 个文件涉及本轮工作');
  });

  it.each([false, true])('distinguishes same-name hosted prose and a different project file (change row: %s)', withChange => {
    const hosted = {...document, hash: 'reply-content', revision: 5, sourcePath: undefined};
    const projectFile = {...document, artifactId: 'generated_v1', document: false, revision: 1, sourcePath: 'docs/方案.md'};
    const html = render([hosted, projectFile], withChange ? [{...change, path: 'docs/方案.md'}] : []);
    expect(html.match(/class="message-document-card"/g)).toHaveLength(2);
    expect(html).toContain('data-zs-artifact-id="doc_v5"');
    expect(html).toContain('data-zs-artifact-id="generated_v1"');
    expect(html.match(/data-zs-file-source="reply"/g)).toHaveLength(1);
    expect(html.match(/data-zs-file-source="project"/g)).toHaveLength(1);
    expect(html).toContain('回复附稿');
    expect(html).toContain('项目文件 · docs/方案.md');
    expect(html).toContain('v5');
    expect(html).toContain('v1');
    const hostedCard = html.slice(html.indexOf('data-zs-artifact-id="doc_v5"'),
      withChange ? html.indexOf('data-zs-document-change=') : html.indexOf('data-zs-artifact-id="generated_v1"'));
    expect(hostedCard).not.toContain('查看变更');
    expect(hostedCard).toContain('data-zs-attachment-open="doc_v5"');
  });

  it('keeps ordinary unique cards and equal-content document versions free of source notes', () => {
    const unique = {...document, artifactId: 'another', filename: '另一份.md', hash: 'other-content'};
    expect(render([document, unique])).not.toContain('data-zs-file-source=');
    const secondVersion = {...document, artifactId: 'doc_v6', revision: 6};
    const equal = render([document, secondVersion]);
    expect(equal.match(/class="message-document-card"/g)).toHaveLength(2);
    expect(equal).not.toContain('data-zs-file-source=');
  });

  it('does not claim a content conflict when a same-name attachment has no known hash', () => {
    const unknown = {...document, artifactId: 'unhashed', document: false, hash: undefined, sourcePath: 'docs/方案.md'};
    const html = render([document, unknown]);
    expect(html.match(/class="message-document-card"/g)).toHaveLength(2);
    expect(html).not.toContain('data-zs-file-source=');
  });
});
