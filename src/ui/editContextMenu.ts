import type { BrowserWindow, ContextMenuParams, Event, Menu, MenuItemConstructorOptions } from 'electron';

type EditContext = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'formControlType' | 'editFlags'>;
type NativeEditMenu = Pick<Menu, 'popup' | 'closePopup'>;

const textControls = new Set<ContextMenuParams['formControlType']>([
  'input-email', 'input-number', 'input-password', 'input-search',
  'input-telephone', 'input-text', 'input-url', 'text-area',
]);

/** Chromium supplies capabilities for the right-click target, including readonly
 * and disabled fields. Do not infer editability from a selection or clipboard. */
export function editContextMenuTemplate(params: EditContext): MenuItemConstructorOptions[] {
  const { editFlags: flags, isEditable, selectionText, formControlType } = params;
  const hasSelection = selectionText.length > 0;
  const password = formControlType === 'input-password';
  const isTextControl = textControls.has(formControlType);
  if (!isEditable && !isTextControl && !hasSelection) return [];

  const copy: MenuItemConstructorOptions = { label: '复制', role: 'copy', enabled: !password && hasSelection && flags.canCopy };
  const selectAll: MenuItemConstructorOptions = { label: '全选', role: 'selectAll', enabled: flags.canSelectAll };
  if (!isEditable && !isTextControl) return [copy, { type: 'separator' }, selectAll];
  return [
    { label: '剪切', role: 'cut', enabled: isEditable && !password && hasSelection && flags.canCut },
    copy,
    { label: '粘贴', role: 'paste', enabled: isEditable && flags.canPaste },
    { type: 'separator' },
    selectAll,
  ];
}

/** Native roles preserve Chromium copy/cut/paste events (including image paste).
 * Focus only the source WebContents, without JS selection changes or clipboard
 * access. Popup window/frame are explicit so another window cannot receive edits. */
export function registerEditContextMenu(
  win: BrowserWindow,
  buildMenu: (items: MenuItemConstructorOptions[]) => NativeEditMenu,
): () => void {
  const contents = win.webContents;
  let activeMenu: NativeEditMenu | null = null;
  const onContextMenu = (event: Event, params: ContextMenuParams): void => {
    if (win.isDestroyed() || contents.isDestroyed() || params.frame?.isDestroyed()) return;
    const items = editContextMenuTemplate(params);
    if (items.length === 0) return;
    event.preventDefault();
    activeMenu?.closePopup(win);
    const menu = buildMenu(items);
    activeMenu = menu;
    contents.focus();
    menu.popup({
      window: win,
      ...(params.frame != null ? { frame: params.frame } : {}),
      sourceType: params.menuSourceType,
      callback: () => { if (activeMenu === menu) activeMenu = null; },
    });
  };
  const dispose = (): void => {
    contents.removeListener('context-menu', onContextMenu);
    contents.removeListener('destroyed', dispose);
    activeMenu?.closePopup();
    activeMenu = null;
  };
  contents.on('context-menu', onContextMenu);
  contents.once('destroyed', dispose);
  return dispose;
}
