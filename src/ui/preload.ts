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
  onDisconnect: (cb: (info: string) => void): void => {
    ipcRenderer.on('zs:disconnect', (_e, info) => cb(info));
  },
  onReconnected: (cb: () => void): void => {
    ipcRenderer.on('zs:reconnected', () => cb());
  },
  onDemoStatus: (cb: (status: string) => void): void => {
    ipcRenderer.on('zs:demo-status', (_e, status) => cb(status));
  },
});
