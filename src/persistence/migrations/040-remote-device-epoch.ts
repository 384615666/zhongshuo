/**
 * 迁移 040（第三十三轮二）：remote_devices.auth_epoch——**设备级授权代次**。
 * 第三十二轮为全局 authEpoch：吊销任一设备会使**所有**设备的 token/票据/活连接失效
 * （多设备互相误伤——B 原本有效，吊销 A 后 B 也 401）。改为每设备独立代次：
 * 吊销 A 只递增 A 的 auth_epoch 并撤销 A 的凭据/token/票据/WS；B 不受影响。
 */
import type { Migration } from '../db.ts';

export const migration040: Migration = {
  id: 40,
  name: 'remote-device-epoch',
  up: (db) => {
    db.exec('ALTER TABLE remote_devices ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0');
  },
};
