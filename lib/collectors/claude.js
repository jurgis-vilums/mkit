import fs from 'node:fs';
import path from 'node:path';
import { makeItem } from '../manifest.js';
import { dirSize, copyTree } from '../fsutil.js';

const ALLOW = ['skills', 'plugins', 'projects', 'hooks', 'agents', 'commands', 'output-styles', 'CLAUDE.md', 'AGENTS.md',
  'settings.json', 'settings.local.json', 'mcp.json', 'keybindings.json'];
const EXTRA = ['.agents', '.config/skillshare'];

const toPosix = (p) => p.split(path.sep).join('/');

function homeItem(ctx, homeRel, id, title) {
  return makeItem({ id, collector: 'claude', kind: 'claude', title, size: dirSize(path.join(ctx.home, homeRel)),
    data: { homeRel: toPosix(homeRel) } });
}

export function collect(ctx) {
  const base = path.join(ctx.home, '.claude');
  const items = [];
  for (const name of ALLOW) {
    const p = path.join(base, name);
    if (!fs.existsSync(p)) continue;
    if (name === 'skills') {
      for (const d of fs.readdirSync(p, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue;
        if (!d.isDirectory() && !d.isSymbolicLink()) continue;
        items.push(homeItem(ctx, path.join('.claude', 'skills', d.name), `claude:skills/${d.name}`, `skill ${d.name}`));
      }
      continue;
    }
    items.push(homeItem(ctx, path.join('.claude', name), `claude:${name}`, name));
  }
  for (const rel of EXTRA) {
    if (fs.existsSync(path.join(ctx.home, rel))) items.push(homeItem(ctx, rel, `claude:~/${toPosix(rel)}`, `~/${toPosix(rel)}`));
  }
  return items;
}

export function stage(ctx, item, stageRoot) {
  const src = fs.realpathSync(path.join(ctx.home, item.data.homeRel)); // follow skillshare symlinks
  copyTree(src, path.join(stageRoot, 'home', item.data.homeRel));
}
