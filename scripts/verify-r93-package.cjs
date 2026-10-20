#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict';

/**
 * R93 candidate acceptance orchestrator.
 *
 * This intentionally reuses the existing, proven R91 and R92 package scripts:
 * - R91: official BAT isolated copy, synthetic visible fixture, 420/700/dark,
 *   avatar/keyboard, preview/save-as SHA256, 5s refresh, IME, reopen.
 * - R92: no-handoff=2 real synthetic turns, handoff=3 turns, no real runtime calls.
 * - --r93-detail adds one legal short answer + one actual hosted Markdown detail
 *   to the R91 fixture and checks its card/preview/save-as/reopen.
 *
 * Usage:
 *   node scripts/verify-r93-package.cjs --package <candidate-dir> --out <evidence-dir> --dry-run
 *   node scripts/verify-r93-package.cjs --package <candidate-dir> --out <evidence-dir>
 *
 * No model/CLI is started. The child scripts use FakeRuntimeAdapter and assert
 * real_calls=0. Do not run the real-output smoke until its BUILD is supplied.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const usage = 'usage: node scripts/verify-r93-package.cjs --package <candidate-dir> [--out <evidence-dir>] [--dry-run] [--keep-copy] [--skip-manifest]';

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (['dry-run', 'keep-copy', 'skip-manifest'].includes(key)) { flags.add(key); continue; }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) throw new Error(`missing value: ${arg}`);
    values.set(key, next);
    i += 1;
  }
  const packageArg = values.get('package');
  if (packageArg == null) throw new Error(usage);
  return {
    packageRoot: path.resolve(repoRoot, packageArg),
    outDir: path.resolve(repoRoot, values.get('out') ?? 'dist/review-r93-package'),
    dryRun: flags.has('dry-run'),
    keepCopy: flags.has('keep-copy'),
    skipManifest: flags.has('skip-manifest'),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLatest(outDir) {
  for (const name of ['latest-result.json', 'result.json']) {
    const file = path.join(outDir, name);
    if (fs.existsSync(file)) return readJson(file);
  }
  return null;
}

function runChild(label, script, args, logFile) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30 * 60 * 1000,
    env: { ...process.env },
  });
  fs.writeFileSync(logFile, `${result.stdout ?? ''}\n${result.stderr ?? ''}`, 'utf8');
  return {
    label,
    exitCode: result.status,
    signal: result.signal,
    logFile,
    ok: result.status === 0,
  };
}

function writeRequirements(outDir) {
  const requirements = {
    format: 'r93-package-acceptance-requirements-v1',
    syntheticOnly: true,
    realModelCalls: 0,
    candidatePackageRequired: true,
    checks: [
      'official BAT isolated copy; server-data excluded',
      'one legal short answer plus one actual hosted complete Markdown detail',
      'generated R91 files, upload/legacy card, and detail card coexist without duplicates',
      'detail card is last, outside fold, click preview, save-as original UTF-8 bytes SHA256',
      '420/700/dark/avatar/keyboard layout',
      'R91 5s refresh, IME/caret/selection stability, reopen persistence',
      'R91 reopen remains real_calls=0',
      'R92 no-handoff scenario remains exactly 2 synthetic turns',
      'R92 handoff scenario remains exactly 3 synthetic turns',
    ],
    reuse: {
      r91: 'scripts/verify-r91-package.cjs --r93-detail',
      r92: 'scripts/verify-r92-package.cjs',
      fixture: 'scripts/prepare-r91-visible-fixture.ts --r93-detail',
    },
    realOutput: {
      status: 'not run; requires BUILD approval',
      allowed: ['Claude/deepseek-flash', 'Codex/ccs-new/glm-5.3-flash'],
      rule: 'no retry, no model switch, no global config/credential/reset changes; failure/UNKNOWN reported truthfully',
    },
  };
  fs.writeFileSync(path.join(outDir, 'ACCEPTANCE-REQUIREMENTS.json'), JSON.stringify(requirements, null, 2), 'utf8');
  return requirements;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error && error.message) || String(error));
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const requirements = writeRequirements(args.outDir);
  const bat = path.join(args.packageRoot, 'start-desktop.bat');
  const build = path.join(args.packageRoot, 'ZhongshuoDual', 'BUILD.json');
  const preflight = {
    packageRoot: args.packageRoot,
    bat,
    build,
    batExists: fs.existsSync(bat),
    buildExists: fs.existsSync(build),
    r91Script: path.join(repoRoot, 'scripts', 'verify-r91-package.cjs'),
    r92Script: path.join(repoRoot, 'scripts', 'verify-r92-package.cjs'),
  };
  preflight.r91Exists = fs.existsSync(preflight.r91Script);
  preflight.r92Exists = fs.existsSync(preflight.r92Script);
  fs.writeFileSync(path.join(args.outDir, 'preflight.json'), JSON.stringify(preflight, null, 2), 'utf8');

  if (args.dryRun) {
    const ok = preflight.batExists && preflight.buildExists && preflight.r91Exists && preflight.r92Exists;
    fs.writeFileSync(path.join(args.outDir, 'result.json'), JSON.stringify({ ok, phase: 'dry-run', requirements, preflight }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok, phase: 'dry-run', out: args.outDir, preflight }, null, 2));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (!preflight.batExists || !preflight.buildExists || !preflight.r91Exists || !preflight.r92Exists) {
    fs.writeFileSync(path.join(args.outDir, 'result.json'), JSON.stringify({ ok: false, phase: 'preflight', error: 'candidate package or reused verifier missing', preflight }, null, 2), 'utf8');
    console.error(JSON.stringify(preflight, null, 2));
    process.exitCode = 2;
    return;
  }

  const common = args.skipManifest ? ['--skip-manifest'] : [];
  const keep = args.keepCopy ? ['--keep-copy'] : [];
  const r92Out = path.join(args.outDir, 'r92');
  const r91Out = path.join(args.outDir, 'r91');
  fs.mkdirSync(r92Out, { recursive: true });
  fs.mkdirSync(r91Out, { recursive: true });
  const r92 = runChild('r92', preflight.r92Script, ['--package', args.packageRoot, '--out', r92Out, ...common, ...keep], path.join(args.outDir, 'r92.log'));
  const r91 = runChild('r91', preflight.r91Script, ['--package', args.packageRoot, '--out', r91Out, '--r93-detail', ...common, ...keep], path.join(args.outDir, 'r91.log'));
  const r92Result = readLatest(r92Out);
  const r91Result = readLatest(r91Out);
  const result = {
    format: 'r93-package-acceptance-v1',
    ok: r92.ok && r91.ok && r92Result?.ok === true && r91Result?.ok === true,
    phase: 'complete',
    synthetic: true,
    realModelCalls: 0,
    packageRoot: args.packageRoot,
    requirements,
    preflight,
    children: { r92, r91 },
    childResults: { r92: r92Result, r91: r91Result },
    detailChecks: (r91Result?.checks ?? []).filter((check) => /R93 detail|detail card|detail preview|detail.*sha|detail/i.test(check.name)),
    r92CallChecks: (r92Result?.checks ?? []).filter((check) => /handoff|call|turn/i.test(check.name)),
  };
  fs.writeFileSync(path.join(args.outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: result.ok, out: args.outDir, r92: result.children.r92, r91: result.children.r91, detailChecks: result.detailChecks }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, main, writeRequirements };
