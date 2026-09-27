// 测试入口：真实主进程/preload，隔离 userData 和单实例锁，不碰用户正在使用的实例。
// 隐藏测试窗口，仅用于数据/设置桥接回归，不能作为窗口显示/托盘验收。
import { app, BrowserWindow } from 'electron';
import { isAbsolute } from 'node:path';
const testData=process.env.ZS_BASELINE_USER_DATA;
if(!testData||!isAbsolute(testData)||!testData.includes('zs-predevelopment-'))throw Error('Dedicated test data directory required');
app.setPath('userData',testData);
BrowserWindow.prototype.show=function(){};
await import('../electron/main.mjs');
