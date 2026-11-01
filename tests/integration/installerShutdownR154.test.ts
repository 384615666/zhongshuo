import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const enabled = process.platform === 'win32' && process.env.ZS_R154_INSTALLER_NATIVE === '1';
const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const fixtureSource = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
[assembly:AssemblyProduct("\u4f17\u8bf4")]
[assembly:AssemblyFileVersion("1.0.0.0")]
class FakeRuntime : Form {
  static bool cooperative;
  static string marker;
  protected override void WndProc(ref Message m) {
    if(m.Msg==0x11) {
      if(cooperative) { File.WriteAllText(marker+".graceful","query-session-end");BeginInvoke(new Action(()=>Application.Exit()));m.Result=new IntPtr(1); }
      else m.Result=IntPtr.Zero;
      return;
    }
    base.WndProc(ref m);
  }
  [STAThread]static void Main(string[] args) {
    marker=Environment.GetEnvironmentVariable("ZS_R154_MARKER");
    if(args.Length>0&&args[0]=="--hold") {
      using(var f=new FileStream(args[1],FileMode.Open,FileAccess.Read,FileShare.Read)) {File.WriteAllText(marker,"ready");Thread.Sleep(Timeout.Infinite);}return;
    }
    if(args.Length>0&&args[0]=="--leaf") {File.WriteAllText(marker,"synthetic runtime task");Thread.Sleep(Timeout.Infinite);return;}
    cooperative=args.Length>0&&args[0]=="--cooperative";
    var window=new FakeRuntime {ShowInTaskbar=false,Opacity=0,Text="R154 isolated synthetic runtime"};
    window.FormClosing+=(sender,e)=>{if(cooperative)File.WriteAllText(marker+".graceful","normal-window-close");};
    window.Shown+=(sender,e)=>{
      string child=Environment.GetEnvironmentVariable("ZS_R154_CHILD");
      if(!String.IsNullOrEmpty(child)) {
        var psi=new ProcessStartInfo(child,"--leaf") {UseShellExecute=false,CreateNoWindow=true};
        psi.EnvironmentVariables["ZS_R154_MARKER"]=marker+".child";
        using(var p=Process.Start(psi))File.WriteAllText(marker+".child-pid",p.Id.ToString());
      }
      File.WriteAllText(marker,"ready");
    };
    Application.Run(window);
  }
}
`;

describe.runIf(enabled)('R154 target-owned installer process shutdown', () => {
  it('refuses unconsented/unknown changes, gracefully closes, and force-stops only the confirmed tree', async () => {
    const repo = resolve(import.meta.dirname, '../..');
    const run = join(repo, 'dist', 'r154-installer-shutdown', randomUUID());
    const target = join(run, 'target app'), other = join(run, 'other install'), outside = join(run, 'external runtime');
    for (const root of [target, other, outside]) mkdirSync(root, { recursive: true });
    const appExe = join(target, 'Zhongshuo.exe');
    const setup = join(run, 'compile-fixture.ps1');
    writeFileSync(setup, `param([string]$Output)\n$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${fixtureSource}\n'@ -OutputAssembly $Output -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing\n`);
    const compilation = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', setup, '-Output', appExe], { encoding: 'utf8', windowsHide: true });
    expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0);
    copyFileSync(appExe, join(other, 'Zhongshuo.exe'));
    copyFileSync(appExe, join(outside, 'node.exe'));
    const markerMetadata = { appId: 'com.zhongshuo.desktop', productName: '众说', executable: 'Zhongshuo.exe' };
    for (const root of [target, other]) {
      mkdirSync(join(root, 'resources/app'), { recursive: true });
      writeFileSync(join(root, 'resources/app/installed-desktop.json'), JSON.stringify(markerMetadata));
    }
    const sentinel = join(target, 'unchanged-user-file'); writeFileSync(sentinel, 'synthetic-only bytes');
    const ticket = join(run, 'ownership.json');
    const helper = join(repo, 'packaging/windows/installer-processes.ps1');
    const reports: unknown[] = [];
    const owned: ChildProcess[] = [];
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const waitFor = async (condition: () => boolean, label: string, ms = 6000) => {
      const deadline = Date.now() + ms;
      while (!condition()) { if (Date.now() >= deadline) throw Error(`Timed out ${label}`); await new Promise(resolveWait => setTimeout(resolveWait, 50)); }
    };
    const start = async (image: string, args: string[], label: string, child?: string) => {
      const marker = join(run, label + '.ready');
      const process = spawn(image, args, { windowsHide: true, env: { ...globalThis.process.env, ZS_R154_MARKER: marker, ZS_R154_CHILD: child ?? '' }, stdio: 'ignore' });
      owned.push(process); await waitFor(() => existsSync(marker), label);
      return { process, marker };
    };
    const invoke = (mode: 'Probe' | 'Graceful' | 'Force', consent = false) => {
      const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-InstallDir', target, '-Mode', mode, '-TicketFile', ticket, '-TimeoutSeconds', '2', ...(consent ? ['-Consent'] : [])], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      const entry = { mode, consent, code: result.status, output: result.stdout + result.stderr, ticket: existsSync(ticket) ? JSON.parse(readFileSync(ticket, 'utf8').replace(/^\uFEFF/, '')) : null };
      reports.push(entry); writeFileSync(join(run, 'operations.json'), JSON.stringify(reports, null, 2)); return entry;
    };
    try {
      const decoy = await start(join(other, 'Zhongshuo.exe'), [], 'other');
      const unrelated = await start(join(outside, 'node.exe'), ['--leaf'], 'unrelated');
      const stubborn = await start(appExe, [], 'stubborn', join(outside, 'node.exe'));
      await waitFor(() => existsSync(stubborn.marker + '.child-pid') && existsSync(stubborn.marker + '.child'), 'synthetic child');
      const childPid = Number(readFileSync(stubborn.marker + '.child-pid', 'utf8'));
      const probe = invoke('Probe');
      expect(probe.code, probe.output).toBe(10);
      expect(probe.ticket.Processes.some((p: { Pid: number }) => p.Pid === childPid)).toBe(true);
      expect(invoke('Force').code).toBe(20);
      expect(alive(stubborn.process.pid!)).toBe(true);
      const before = readFileSync(ticket);
      const bad = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
      for (const identity of bad.Approved) if (identity.Pid === stubborn.process.pid) identity.Start = '1';
      writeFileSync(ticket, JSON.stringify(bad));
      expect(invoke('Force', true).code).toBe(20);
      expect(alive(stubborn.process.pid!)).toBe(true);
      writeFileSync(ticket, before);
      const graceful = invoke('Graceful');
      expect(graceful.code, graceful.output).toBe(10);
      expect(alive(stubborn.process.pid!)).toBe(true);
      expect(alive(childPid)).toBe(true);
      const forced = invoke('Force', true);
      expect(forced.code, forced.output).toBe(0);
      await waitFor(() => !alive(stubborn.process.pid!) && !alive(childPid), 'confirmed tree gone');
      expect(alive(decoy.process.pid!)).toBe(true);
      expect(alive(unrelated.process.pid!)).toBe(true);
      expect(invoke('Probe').code).toBe(0);
      expect(readFileSync(sentinel, 'utf8')).toBe('synthetic-only bytes');
      const metadataFile = join(target, 'resources/app/installed-desktop.json');
      writeFileSync(metadataFile, 'damaged metadata');
      expect(invoke('Probe').code).toBe(0);
      writeFileSync(metadataFile, JSON.stringify(markerMetadata));
      const normal = await start(appExe, ['--cooperative'], 'normal');
      expect(invoke('Probe').code).toBe(10);
      const stopped = invoke('Graceful');
      expect(stopped.code, stopped.output).toBe(0);
      expect(existsSync(normal.marker + '.graceful')).toBe(true);
      const parent = await start(appExe, ['--cooperative'], 'parent', join(outside, 'node.exe'));
      await waitFor(() => existsSync(parent.marker + '.child-pid') && existsSync(parent.marker + '.child'), 'second synthetic child');
      const orphanPid = Number(readFileSync(parent.marker + '.child-pid', 'utf8'));
      expect(invoke('Probe').code).toBe(10);
      const parentStopped = invoke('Graceful');
      expect(parentStopped.code, parentStopped.output).toBe(10);
      expect(alive(parent.process.pid!)).toBe(false);
      expect(alive(orphanPid)).toBe(true);
      expect(invoke('Force', true).code).toBe(0);
      await waitFor(() => !alive(orphanPid), 'originally verified child after parent exit');
      expect(invoke('Probe').code).toBe(0);
      const holder = await start(join(outside, 'node.exe'), ['--hold', appExe], 'holder');
      const unknown = invoke('Probe');
      expect(unknown.code, unknown.output).toBe(20);
      expect(invoke('Force', true).code).toBe(20);
      expect(alive(holder.process.pid!)).toBe(true);
      writeFileSync(join(run, 'report.json'), JSON.stringify({ ok: true, run, checks: ['probe captures target and external descendant', 'no consent refuses', 'PID start mismatch refuses', 'unresponsive graceful stays alive', 'consented force ends owned tree', 'other install survives', 'unrelated node survives', 'post-stop probe clear', 'target bytes unchanged', 'stopped damaged installation can be repaired', 'query-session-end graceful closes without termination', 'retains verified lineage after graceful parent exit', 'unknown file holder refuses before force'], realModelCalls: 0, reports }, null, 2));
      console.log(`R154_INSTALLER_SHUTDOWN ${run}`);
    } finally {
      // Only fixture processes created above, never process-name discovery.
      for (const process of owned) if (process.exitCode == null) process.kill();
      // A failed assertion before Force must not strand the synthetic runtime
      // spawned by the fixture itself. Resolve only PID markers in this run,
      // and require the exact per-run executable before terminating its handle.
      const cleanup = join(run, 'cleanup-children.ps1');
      writeFileSync(cleanup, `param([string]$RunRoot)\n$ErrorActionPreference='Stop'\nGet-ChildItem -LiteralPath $RunRoot -Filter '*.child-pid' | ForEach-Object {\n  $fixturePid=[int](Get-Content -LiteralPath $_.FullName -Raw)\n  $fixtureProcess=Get-Process -Id $fixturePid -ErrorAction SilentlyContinue\n  if($null -ne $fixtureProcess -and $fixtureProcess.Path -eq (Join-Path $RunRoot 'external runtime/node.exe')) { $fixtureProcess.Kill(); $fixtureProcess.WaitForExit(3000) | Out-Null }\n}\n`);
      spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cleanup, '-RunRoot', run], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    }
  }, 60000);
});
