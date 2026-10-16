import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// npm/npx are .cmd shims on Windows (resolved via PATHEXT), and since Node's
// CVE-2024-27980 fix, spawning a .cmd/.bat file directly fails without a
// shell. Routing through cmd.exe is NOT safe here — cmd.exe interprets shell
// metacharacters (|, &, >, %VAR%, ^) in the arguments mkit passes through
// (e.g. an npm package name), which is a command-injection hole. Instead,
// run npm's own JS entry point directly with node — no shell involved, so
// args reach npm as plain argv with no reinterpretation.
const NPM_CLI_SCRIPT = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

function npmCliScriptPath(name) {
  const nodeDir = path.dirname(process.execPath);
  const script = path.join(nodeDir, 'node_modules', 'npm', 'bin', NPM_CLI_SCRIPT[name]);
  if (!fs.existsSync(script)) {
    throw new Error(`cannot find ${NPM_CLI_SCRIPT[name]} next to node (expected at ${script}) — is npm bundled with this Node install?`);
  }
  return script;
}

export function realExec(cmd, args = [], opts = {}) {
  const spawnOpts = { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, ...opts };
  let spawnCmd = cmd;
  let spawnArgs = args;
  if (process.platform === 'win32') {
    const lower = cmd.toLowerCase();
    if (lower === 'npm' || lower === 'npx') {
      spawnCmd = process.execPath;
      spawnArgs = [npmCliScriptPath(lower), ...args];
    } else if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      throw new Error(`refusing to run .cmd/.bat shim ${cmd} without a shell`);
    }
  }
  const r = spawnSync(spawnCmd, spawnArgs, spawnOpts);
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message) };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function makeCtx(over = {}) {
  const home = over.home ?? os.homedir();
  const platform = over.platform ?? process.platform;
  const win = platform === 'win32';
  return {
    home,
    platform,
    hostname: over.hostname ?? os.hostname(),
    devRoot: over.devRoot ?? path.join(home, 'Documents', 'dev'),
    appData: over.appData ?? (win ? path.join(home, 'AppData', 'Roaming') : null),
    localAppData: over.localAppData ?? (win ? path.join(home, 'AppData', 'Local') : null),
    exec: over.exec ?? realExec,
  };
}

// exec that throws on non-zero exit — use where failure must abort the step
export function mustExec(ctx, cmd, args = [], opts) {
  const r = ctx.exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
