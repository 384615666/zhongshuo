import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

// Copied beside the portable package's opt-in launcher; contains no local data path.
export function assertExistingDatabase(appDataDir) {
  const fd = openSync(join(appDataDir, 'state.sqlite'), 'r');
  try {
    const header = Buffer.alloc(16);
    if (readSync(fd, header, 0, 16, 0) !== 16 || header.toString('binary') !== 'SQLite format 3\u0000') {
      throw Error('Existing state.sqlite has an invalid or empty SQLite header.');
    }
  } finally { closeSync(fd); }
}

export function prepareExistingDataLaunch(packageDir, parentEnv = process.env) {
  const config = JSON.parse(readFileSync(join(packageDir, 'existing-data.json'), 'utf8'));
  if (typeof config.appDataDir !== 'string' || !isAbsolute(config.appDataDir)) {
    throw Error('existing-data.json must name an absolute existing data directory.');
  }
  const appDataDir = resolve(config.appDataDir);
  assertExistingDatabase(appDataDir);
  const executable = join(packageDir, 'ZhongshuoDual', 'electron.exe');
  if (!existsSync(executable)) throw Error('Packaged electron.exe is missing.');
  const pipeFile = join(appDataDir, 'pipe-name.txt');
  if (!existsSync(pipeFile)) {
    try {
      writeFileSync(pipeFile, `zs-daily-${randomUUID()}\r\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const pipeName = readFileSync(pipeFile, 'utf8').trim();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(pipeName)) {
    throw Error('pipe-name.txt is empty or invalid. Existing file was preserved.');
  }
  const env = { ...parentEnv };
  const allowed = new Set(['ZS_DEV25_DEBUG_PORT', 'ZS_TEST_DISPLAY', 'ZS_TEST_WINDOW_BOUNDS', 'ZS_TEST_PLACEMENT_FILE']);
  for (const key of Object.keys(env)) {
    if ((key.toUpperCase().startsWith('ZS_') && !allowed.has(key)) || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  Object.assign(env, { ZS_APP_DATA: appDataDir, ZS_RUNTIME: 'claude', ZS_PIPE_NAME: `\\\\.\\pipe\\${pipeName}` });
  const args = [];
  if (env.ZS_DEV25_DEBUG_PORT != null) {
    if (!/^\d+$/.test(env.ZS_DEV25_DEBUG_PORT) || Number(env.ZS_DEV25_DEBUG_PORT) < 1 || Number(env.ZS_DEV25_DEBUG_PORT) > 65535) {
      throw Error('Invalid engineering debug port.');
    }
    args.push(`--remote-debugging-port=${env.ZS_DEV25_DEBUG_PORT}`);
  }
  return { executable, args, env, cwd: packageDir };
}

async function main() {
  const packageDir = dirname(fileURLToPath(import.meta.url));
  const logFile = join(packageDir, 'startup-existing-data.log');
  let logFd;
  try {
    logFd = openSync(logFile, 'a');
    appendFileSync(logFd, `\n[launcher] ${new Date().toISOString()}\n`);
    const plan = prepareExistingDataLaunch(packageDir);
    appendFileSync(logFd, `[launcher] existing data: ${plan.env.ZS_APP_DATA}\n`);
    const startOffset = readFileSync(logFile).length;
    const child = spawn(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => done(exitCode ?? 1));
    });
    appendFileSync(logFd, `[launcher] application exit: ${code}\n`);
    if (code === 0 && !readFileSync(logFile).subarray(startOffset).toString('utf8').includes('[zhongshuo-ui] ready: auth.ok')) {
      throw Error('Application exited before the desktop connected to its daemon. See startup log above.');
    }
    process.exitCode = code;
  } catch (error) {
    const message = `[launcher] Startup failed: ${error.message}\n`;
    if (logFd != null) appendFileSync(logFd, message);
    process.stderr.write(message);
    process.exitCode = 1;
  } finally {
    if (logFd != null) closeSync(logFd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
