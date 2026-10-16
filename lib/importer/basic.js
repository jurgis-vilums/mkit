import fs from 'node:fs';
import path from 'node:path';
import { copyTree, walk } from '../fsutil.js';
import { rewriteText, rewriteTree, rewriteProjectDirName } from '../rewrite.js';
import { installCommand, binaryName } from '../collectors/tools.js';

const ok = () => ({ status: 'ok' });
const failed = (reason) => ({ status: 'failed', reason });
const agent = (reason) => ({ status: 'needs-agent', reason });
const tgt = (tctx) => ({ home: tctx.home, platform: tctx.platform });

export function hasBinary(tctx, name) {
  return tctx.exec(tctx.platform === 'win32' ? 'where' : 'which', [name]).code === 0;
}

// `apt-get update` is run at most once per process, before the first apt
// install — not before every single one.
let aptUpdated = false;

export async function restoreTool(tctx, item) {
  const name = item.data.name;
  if (hasBinary(tctx, binaryName(name, tctx.platform))) return ok();
  const cmd = installCommand(name, tctx.platform);
  if (!cmd) return agent(`install ${name} manually (no package mapping for ${tctx.platform})`);
  // Same sudo decision as the apt-get path, extended to gh's linux install
  // script (CATALOG.gh.linux), which also needs root (it writes to /etc/apt)
  // but isn't itself an `apt-get` invocation.
  const needsSudo = tctx.platform === 'linux' && (cmd[0] === 'apt-get' || name === 'gh') && process.getuid?.() !== 0;
  if (cmd[0] === 'apt-get' && !aptUpdated) {
    const update = needsSudo ? ['sudo', 'apt-get', 'update'] : ['apt-get', 'update'];
    const u = tctx.exec(update[0], update.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    if (u.code !== 0) return failed(`${update.join(' ')} exited ${u.code}: ${(u.stderr || u.stdout).trim().slice(-400)}`);
    aptUpdated = true;
  }
  const full = needsSudo ? ['sudo', ...cmd] : cmd;
  const r = tctx.exec(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  return r.code === 0 ? ok() : failed(`${full.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-400)}`);
}

// Backs up dstFile to `${dstFile}.mkit-backup` iff it already exists and
// differs from what's about to be written. COPYFILE_EXCL means a backup from
// an earlier run is kept as-is rather than clobbered with the (already
// migrated) current content.
function backupIfDiffers(srcFile, dstFile) {
  if (!fs.existsSync(dstFile)) return;
  if (Buffer.compare(fs.readFileSync(dstFile), fs.readFileSync(srcFile)) === 0) return;
  try {
    fs.copyFileSync(dstFile, `${dstFile}.mkit-backup`, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

function placeHome(tctx, payloadRoot, homeRel) {
  const src = path.join(payloadRoot, 'home', homeRel);
  const dst = path.join(tctx.home, homeRel);
  if (!fs.existsSync(src)) throw new Error(`payload missing ${homeRel}`);
  if (fs.statSync(src).isFile()) backupIfDiffers(src, dst);
  else walk(src, (rel, abs) => backupIfDiffers(abs, path.join(dst, rel)));
  copyTree(src, dst);
  return dst;
}

function chmodTree(p, dirMode, fileMode) {
  if (fs.statSync(p).isDirectory()) {
    fs.chmodSync(p, dirMode);
    for (const n of fs.readdirSync(p)) chmodTree(path.join(p, n), dirMode, fileMode);
  } else fs.chmodSync(p, fileMode);
}

export async function restoreSecret(tctx, item, payloadRoot, source) {
  if (item.kind === 'relogin') return agent(`re-login required: ${item.data.how}`);
  if (item.kind === 'gh-token') {
    if (!hasBinary(tctx, 'gh')) {
      return agent('gh CLI missing — install it, then: gh auth login --with-token < ~/.mkit/payload/tokens/gh-token && gh auth setup-git');
    }
    const token = fs.readFileSync(path.join(payloadRoot, 'tokens', 'gh-token'), 'utf8').trim();
    const r = tctx.exec('gh', ['auth', 'login', '--with-token'], { input: token });
    if (r.code !== 0) return failed(`gh auth login failed: ${r.stderr.trim()}`);
    const s = tctx.exec('gh', ['auth', 'setup-git']);
    return s.code === 0 ? ok() : failed(`gh auth setup-git failed: ${s.stderr.trim()}`);
  }
  const dst = placeHome(tctx, payloadRoot, item.data.homeRel);
  if (item.data.homeRel === '.claude.json') fs.writeFileSync(dst, rewriteText(fs.readFileSync(dst, 'utf8'), source, tgt(tctx)));
  if (tctx.platform !== 'win32' && item.data.homeRel === '.ssh') chmodTree(dst, 0o700, 0o600);
  if (tctx.platform === 'darwin' && item.data.homeRel === '.claude/.credentials.json') {
    return agent('macOS keeps Claude credentials in the Keychain: run `claude` and /login');
  }
  return ok();
}

export async function restoreClaude(tctx, item, payloadRoot, source) {
  const dst = placeHome(tctx, payloadRoot, item.data.homeRel);
  const { links } = rewriteTree(dst, source, tgt(tctx));
  if (links.length) return agent(`symlinks not rewritten: ${links.join(', ')}`);
  if (item.id === 'claude:projects') {
    for (const n of fs.readdirSync(dst)) {
      const renamed = rewriteProjectDirName(n, source, tgt(tctx));
      if (renamed === n) continue;
      if (fs.existsSync(path.join(dst, renamed))) return failed(`project history dir collision: ${renamed}`);
      fs.renameSync(path.join(dst, n), path.join(dst, renamed));
    }
  }
  return ok();
}

export async function restoreShell(tctx, item, payloadRoot) {
  const dst = path.join(tctx.home, '.mkit', 'shell', item.data.key);
  copyTree(path.join(payloadRoot, 'shell', item.data.key), dst);
  return { status: 'todo', reason: `${item.data.sub} from ${item.data.abs} — saved to ${dst}; see RUNBOOK "Shell extras"` };
}
