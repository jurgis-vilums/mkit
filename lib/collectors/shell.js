import fs from 'node:fs';
import path from 'node:path';
import { makeItem } from '../manifest.js';

const toPosix = (p) => p.split(path.sep).join('/');

function mk(ctx, sub, abs) {
  const key = `${sub}-${path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const rel = path.relative(ctx.home, abs);
  return makeItem({ id: `shell:${key}`, collector: 'shell', kind: 'shell-extra', title: `${sub}: ${path.basename(abs)}`,
    size: fs.statSync(abs).size, data: { sub, key, abs, homeRel: rel.startsWith('..') ? null : toPosix(rel) } });
}

export function collect(ctx) {
  if (ctx.platform !== 'win32') return [];
  const items = [];
  const r = ctx.exec('pwsh', ['-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts; $PROFILE.CurrentUserCurrentHost']);
  if (r.code !== 0) throw new Error(`reading $PROFILE failed: ${r.stderr}`);
  for (const p of [...new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]) {
    if (fs.existsSync(p)) items.push(mk(ctx, 'ps-profile', p));
  }
  const ahkDir = path.join(ctx.home, 'Documents', 'AutoHotkey');
  if (fs.existsSync(ahkDir)) {
    for (const f of fs.readdirSync(ahkDir)) if (f.toLowerCase().endsWith('.ahk') && !f.includes('.backup-')) items.push(mk(ctx, 'ahk', path.join(ahkDir, f)));
  }
  const pt = path.join(ctx.localAppData, 'Microsoft', 'PowerToys', 'Keyboard Manager', 'default.json');
  if (fs.existsSync(pt)) items.push(mk(ctx, 'powertoys', pt));
  return items;
}

export function stage(ctx, item, stageRoot) {
  const out = path.join(stageRoot, 'shell', item.data.key);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(item.data.abs, path.join(out, path.basename(item.data.abs)));
}
