import fs from 'node:fs';
import path from 'node:path';
import { copyTree, walk, isExcludedPath } from '../fsutil.js';
import { mustExec } from '../ctx.js';
import { rewriteText, TEXT_EXT } from '../rewrite.js';

function hardcodedPaths(dir, source, target) {
  const hits = [];
  walk(dir, (rel, abs) => {
    if (rel.startsWith('.git/') || !TEXT_EXT.has(path.extname(abs).toLowerCase())) return;
    const t = fs.readFileSync(abs, 'utf8');
    if (rewriteText(t, source, target) !== t) hits.push(rel);
  }, { exclude: isExcludedPath });
  return hits;
}

// Never let git fall back to an interactive credential/host-key prompt during
// import — a private repo cloned without credentials (or with a stale host
// key) must fail fast with git's own error, not hang the importer waiting on
// a terminal/GUI prompt that will never be answered.
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
};

export async function restoreProject(tctx, item, payloadRoot, source) {
  const d = item.data;
  const segs = d.rel.split('/');
  const dst = d.choice === 'archive' ? path.join(tctx.devRoot, '_archive', ...segs) : path.join(tctx.devRoot, ...segs);
  if (fs.existsSync(dst) && fs.readdirSync(dst).length) return { status: 'failed', reason: `target exists: ${dst}` };
  // Build into a <dst>.mkit-partial sibling and rename it onto dst only once
  // everything succeeds, so a failed attempt (e.g. a patch that won't apply)
  // leaves no <dst> behind and can simply be retried.
  const partial = `${dst}.mkit-partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  const pay = path.join(payloadRoot, 'projects', ...segs);
  const g = (...a) => mustExec(tctx, 'git', a, { env: { ...process.env, ...GIT_NO_PROMPT_ENV } });
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  if (d.git) {
    if (d.remote) {
      g('clone', '--no-checkout', d.remote, partial);
      const b = path.join(pay, 'unpushed.bundle');
      if (fs.existsSync(b)) g('-C', partial, 'fetch', b, '+refs/heads/*:refs/heads/*', '--update-head-ok');
    } else {
      g('clone', '--no-checkout', path.join(pay, 'all.bundle'), partial);
      g('-C', partial, 'remote', 'remove', 'origin');
    }
    g('-C', partial, 'checkout', d.branch || d.head);
    const patch = path.join(pay, 'dirty.patch');
    if (fs.existsSync(patch)) g('-C', partial, 'apply', '--binary', patch);
  }
  const files = path.join(pay, 'files');
  if (fs.existsSync(files)) copyTree(files, partial, { exclude: isExcludedPath });
  else fs.mkdirSync(partial, { recursive: true });
  fs.renameSync(partial, dst);
  const hits = hardcodedPaths(dst, source, { home: tctx.home, platform: tctx.platform });
  if (hits.length) return { status: 'needs-agent', reason: `hardcoded source paths in ${hits.length} files: ${hits.slice(0, 5).join(', ')}` };
  return { status: 'ok' };
}
