import fs from 'node:fs';
import path from 'node:path';
import { makeItem } from '../manifest.js';
import { dirSize, copyTree } from '../fsutil.js';
import { mustExec } from '../ctx.js';

const toPosix = (p) => p.split(path.sep).join('/');

export function collect(ctx) {
  const rels = ['.claude/.credentials.json', '.claude.json', '.ssh', path.relative(ctx.home, path.join(ctx.devRoot, '.secrets')),
    '.cloudflared', '.gitconfig', '.config/glab-cli/config.yml'];
  if (ctx.appData) rels.push(path.relative(ctx.home, path.join(ctx.appData, 'glab-cli', 'config.yml')));
  const items = [];
  for (const r of rels) {
    const rel = toPosix(r);
    const abs = path.join(ctx.home, rel);
    if (!fs.existsSync(abs)) continue;
    items.push(makeItem({ id: `secret:${rel}`, collector: 'secrets', kind: 'home-file', title: rel, size: dirSize(abs), data: { homeRel: rel } }));
  }
  if (ctx.exec('gh', ['auth', 'token']).code === 0) {
    items.push(makeItem({ id: 'secret:gh-token', collector: 'secrets', kind: 'gh-token', title: 'GitHub CLI token' }));
  }
  if (fs.existsSync(path.join(ctx.home, '.azure'))) {
    items.push(makeItem({ id: 'secret:azure', collector: 'secrets', kind: 'relogin', title: 'Azure CLI login',
      data: { how: 'az login' } }));
  }
  return items;
}

export function stage(ctx, item, stageRoot) {
  if (item.kind === 'home-file') return copyTree(path.join(ctx.home, item.data.homeRel), path.join(stageRoot, 'home', item.data.homeRel));
  if (item.kind === 'gh-token') {
    const token = mustExec(ctx, 'gh', ['auth', 'token']).trim();
    fs.mkdirSync(path.join(stageRoot, 'tokens'), { recursive: true });
    fs.writeFileSync(path.join(stageRoot, 'tokens', 'gh-token'), token);
  }
  // relogin: nothing to stage
}
