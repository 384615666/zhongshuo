/**
 * shell：组合真实 store 与 loader 的门面（供 App/页面单向依赖，避免 store↔loader 循环）。
 */
import { useStore, setState, getState, toast, clearToast, setTheme, recordWrite, recordLocalOnly } from './data/store';
import {
  bootRemembered, openProjectByPath, pickAndOpenFolder, refreshMembers, refreshRooms, refreshDms,
  loadRoomPool, loadDmHistory, sendRoomRoot, sendDmMessage, createDm,
} from './loader';

export { useStore, setState, getState, toast, clearToast, setTheme, recordWrite, recordLocalOnly };
export { bootRemembered, openProjectByPath, pickAndOpenFolder, refreshMembers, refreshRooms, refreshDms, loadRoomPool, loadDmHistory, sendRoomRoot, sendDmMessage, createDm };

/** legacy 接管状态（记录原因，便于诊断；显示切换由 body.legacy-on CSS 承担）。 */
export interface HifiUi {
  legacyEnter(reason: string): void;
  legacyExit(): void;
  pickAndOpenFolder(): Promise<void>;
}

export function hifiUi(): HifiUi {
  return {
    legacyEnter(reason) { setState((s) => ({ ...s, legacyActive: true, legacyReason: reason })); },
    legacyExit() { setState((s) => ({ ...s, legacyActive: false })); },
    pickAndOpenFolder: () => pickAndOpenFolder(),
  };
}
