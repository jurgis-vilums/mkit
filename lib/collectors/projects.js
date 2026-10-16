import fs from 'node:fs';
import path from 'node:path';
import { makeItem } from '../manifest.js';
import { dirSize, copyTree, isExcludedPath } from '../fsutil.js';
import { mustExec } from '../ctx.js';

const SKIP_DEFAULT = (name) => name.startsWith('.') || ['~', 'tmp', 'yt_temp'].includes(name);
const OWNED_ELSEWHERE = new Set(['apps', '.secrets']);

function listFolders(ctx) {
  const out = [];
  const add = (base, prefix) => {
    if (!fs.existsSync(base)) return;
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (!prefix && OWNED_ELSEWHERE.has(d.name)) continue;
      out.push({ name: d.name, rel: prefix + d.name, abs: path.join(base, d.name) });
    }
  };
  add(ctx.devRoot, '');
  add(path.join(ctx.devRoot, 'apps'), 'apps/');
  return out;
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

// Drops user:pass@ / token@ userinfo from an https(s) remote URL before it's
// stored in the manifest. ssh forms (git@host:path, ssh://user@host/...) are
// left untouched — that "user" is a fixed account name, not a credential.
function stripRemoteCreds(url) {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
}

function gitFacts(ctx, dir) {
  const g = (...a) => ctx.exec('git', ['-C', dir, ...a]);
  const remoteR = g('remote', 'get-url', 'origin');
  const remote = remoteR.code === 0 ? stripRemoteCreds(remoteR.stdout.trim()) : null;
  const branch = g('branch', '--show-current').stdout.trim();
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const unpushed = remote ? lines(g('rev-list', '--branches', '--not', '--remotes').stdout).length : 0;
  const dirty = lines(g('diff', 'HEAD', '--name-only').stdout).length;
  const untracked = lines(g('ls-files', '--others', '--exclude-standard').stdout);
  const ignored = lines(g('ls-files', '--others', '--ignored', '--exclude-standard', '--directory').stdout);
  const extras = [...untracked, ...ignored].map((p) => p.replace(/\/$/, '')).filter((p) => !isExcludedPath(p));
  return { remote, branch, head, unpushed, dirty, extras: [...new Set(extras)] };
}

export function collect(ctx) {
  return listFolders(ctx).map(({ name, rel, abs }) => {
    const isGit = fs.existsSync(path.join(abs, '.git'));
    const facts = isGit ? gitFacts(ctx, abs) : null;
    const size = isGit ? facts.extras.reduce((n, e) => n + dirSize(path.join(abs, e), { exclude: isExcludedPath }), 0) : dirSize(abs, { exclude: isExcludedPath });
    return makeItem({ id: `project:${rel}`, collector: 'projects', kind: 'project', title: rel, size,
      data: { rel, git: isGit, ...(facts ?? { remote: null, branch: null, head: null, unpushed: 0, dirty: 0, extras: [] }),
        defaultChoice: SKIP_DEFAULT(name) ? 'skip' : 'migrate' } });
  });
}

export function stage(ctx, item, stageRoot) {
  const d = item.data;
  const src = path.join(ctx.devRoot, ...d.rel.split('/'));
  const out = path.join(stageRoot, 'projects', ...d.rel.split('/'));
  fs.mkdirSync(out, { recursive: true });
  if (!d.git) return copyTree(src, path.join(out, 'files'), { exclude: isExcludedPath });
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ remote: d.remote, branch: d.branch }));
  if (!d.remote) mustExec(ctx, 'git', ['-C', src, 'bundle', 'create', path.join(out, 'all.bundle'), '--all']);
  else if (d.unpushed > 0) mustExec(ctx, 'git', ['-C', src, 'bundle', 'create', path.join(out, 'unpushed.bundle'), '--branches', '--not', '--remotes']);
  if (d.dirty > 0) fs.writeFileSync(path.join(out, 'dirty.patch'), mustExec(ctx, 'git', ['-C', src, 'diff', 'HEAD', '--binary']));
  for (const e of d.extras) copyTree(path.join(src, e), path.join(out, 'files', e), { exclude: isExcludedPath });
}
