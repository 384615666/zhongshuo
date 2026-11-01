import { EventEmitter } from 'node:events';
import type { BrowserWindow, ContextMenuParams } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { editContextMenuTemplate, registerEditContextMenu } from '../../src/ui/editContextMenu.ts';

function context(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    isEditable: true, selectionText: 'selected text', formControlType: 'input-text', frame: null, menuSourceType: 'mouse',
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: true, canEditRichly: false },
    ...overrides,
  } as ContextMenuParams;
}
const actions = (params: ContextMenuParams) => editContextMenuTemplate(params).filter(item => item.role).map(item => ({ label: item.label, role: item.role, enabled: item.enabled }));

describe('R153 native edit context menu', () => {
  it.each(['input-text', 'text-area', 'none'] as const)('uses native roles for %s / contenteditable without replacing paste', formControlType => {
    expect(actions(context({ formControlType }))).toEqual([
      { label: '剪切', role: 'cut', enabled: true }, { label: '复制', role: 'copy', enabled: true },
      { label: '粘贴', role: 'paste', enabled: true }, { label: '全选', role: 'selectAll', enabled: true },
    ]);
    for (const item of editContextMenuTemplate(context({ formControlType }))) expect(item.click).toBeUndefined();
  });

  it('enables paste/select-all but not copy/cut in an empty selection', () => {
    expect(actions(context({ selectionText: '' })).map(item => item.enabled)).toEqual([false, false, true, true]);
  });

  it('respects every Chromium edit flag, including clipboard unavailability', () => {
    const params = context();
    params.editFlags = { ...params.editFlags, canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
    expect(actions(params).every(item => item.enabled === false)).toBe(true);
  });

  it('prevents password extraction even if selection/capability flags claim otherwise', () => {
    expect(actions(context({ formControlType: 'input-password' })).map(item => item.enabled)).toEqual([false, false, true, true]);
  });

  it('readonly text can be copied/selected but never cut or pasted', () => {
    expect(actions(context({ isEditable: false })).map(item => item.enabled)).toEqual([false, true, false, true]);
  });

  it('disabled controls never gain an edit capability from a stale selection', () => {
    const params = context({ isEditable: false });
    params.editFlags = { ...params.editFlags, canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
    expect(actions(params).every(item => item.enabled === false)).toBe(true);
  });

  it('offers copy/select-all on ordinary text, including selected whitespace', () => {
    expect(actions(context({ isEditable: false, formControlType: 'none', selectionText: '  ' }))).toEqual([
      { label: '复制', role: 'copy', enabled: true }, { label: '全选', role: 'selectAll', enabled: true },
    ]);
    expect(editContextMenuTemplate(context({ isEditable: false, formControlType: 'none', selectionText: '' }))).toEqual([]);
  });

  it('uses the source WebContents and frame, without choosing a globally focused window', () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), focus: vi.fn() });
    const win = { webContents: contents, isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
    const menu = { popup: vi.fn(), closePopup: vi.fn() };
    const build = vi.fn(() => menu);
    const dispose = registerEditContextMenu(win, build);
    const event = { preventDefault: vi.fn() };
    const frame = { isDestroyed: () => false } as unknown as NonNullable<ContextMenuParams['frame']>;
    contents.emit('context-menu', event, context({ frame }));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(contents.focus).toHaveBeenCalledOnce();
    expect(menu.popup).toHaveBeenCalledWith({ window: win, frame, sourceType: 'mouse', callback: expect.any(Function) });
    dispose(); contents.emit('context-menu', event, context());
    expect(build).toHaveBeenCalledOnce(); expect(menu.closePopup).toHaveBeenCalledOnce();
  });

  it('leaves unrelated empty context alone and ignores destroyed targets', () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), focus: vi.fn() });
    const win = { webContents: contents, isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
    const build = vi.fn(() => ({ popup: vi.fn(), closePopup: vi.fn() }));
    registerEditContextMenu(win, build);
    const event = { preventDefault: vi.fn() };
    contents.emit('context-menu', event, context({ isEditable: false, formControlType: 'none', selectionText: '' }));
    contents.emit('context-menu', event, context({ frame: { isDestroyed: () => true } as unknown as NonNullable<ContextMenuParams['frame']> }));
    expect(build).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
    contents.emit('destroyed'); expect(contents.listenerCount('context-menu')).toBe(0);
  });
});
