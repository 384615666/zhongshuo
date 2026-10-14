/**
 * preload（DEV-07）：唯一暴露面 = zs.command（经 main 转发 daemon）、zs.pickFolder 与
 * zs.openPath（仅导出目录——main 侧路径白名单）。无 Node 直访；renderer 不能读 SQLite、
 * 不能拉起 runtime。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zs', {
  command: (envelope: unknown): Promise<unknown> => ipcRenderer.invoke('zs:command', envelope),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('zs:pickFolder'),
  openPath: (target: string): Promise<string> => ipcRenderer.invoke('zs:openPath', target) as Promise<string>,
  diagnostics: () => ipcRenderer.invoke('zs:diagnostics'),
  onConnection: (cb: (facts:unknown)=>void) => {const listener=(_e:Electron.IpcRendererEvent,facts:unknown)=>cb(facts);ipcRenderer.on('zs:connection',listener);return()=>ipcRenderer.removeListener('zs:connection',listener);},
  onDisconnect: (cb: (info: string) => void) => {
    const listener=(_e:Electron.IpcRendererEvent,info:string)=>cb(info);ipcRenderer.on('zs:disconnect',listener);return()=>ipcRenderer.removeListener('zs:disconnect',listener);
  },
  onReconnected: (cb: () => void) => {
    const listener=()=>cb();ipcRenderer.on('zs:reconnected',listener);return()=>ipcRenderer.removeListener('zs:reconnected',listener);
  },
  onDemoStatus: (cb: (status: string) => void): void => {
    ipcRenderer.on('zs:demo-status', (_e, status) => cb(status));
  },
});

/**
 * 窗口控制窄桥（第五十四轮 H3 §3）：仅枚举动作，经 main 侧 zs:window 校验（senderFrame
 * zsres://app/ 白名单+枚举拒绝+只作用于可信主窗口）。close 沿既有优雅收口链。
 */
contextBridge.exposeInMainWorld('zsWindow', {
  minimize: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('zs:window', 'minimize'),
  toggleMaximize: (): Promise<{ ok: boolean; maximized?: boolean }> => ipcRenderer.invoke('zs:window', 'toggleMaximize'),
  close: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('zs:window', 'close'),
  getState: (): Promise<{ ok: boolean; state?: { maximized: boolean; fullScreen: boolean; focused: boolean; bounds: Electron.Rectangle; contentBounds: Electron.Rectangle } }> => ipcRenderer.invoke('zs:window', 'getState'),
  onStateChange: (cb: (s: { maximized: boolean; fullScreen: boolean; focused: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, s: { maximized: boolean; fullScreen: boolean; focused: boolean }): void => cb(s);
    ipcRenderer.on('zs:window-state', listener);
    return () => ipcRenderer.removeListener('zs:window-state', listener);
  },
});

/**
 * 「另存为」窄桥（R66 P5：预览当前文件的下载原文件/另存为）——renderer 只提交建议文件名与
 * 已从 daemon 正式只读命令取得的原件字节；**保存路径由系统对话框的用户选择决定**（renderer
 * 不能指定路径）。main 侧 senderFrame 白名单+64MB 上限+basename 归一（zs:saveAs）。
 */
contextBridge.exposeInMainWorld('zsDownload', {
  saveAs: (payload: { suggestedName: string; contentBase64: string }): Promise<{ ok: boolean; cancelled?: boolean; path?: string; bytes?: number }> =>
    ipcRenderer.invoke('zs:saveAs', payload),
});
