import fs from 'node:fs';
import path from 'node:path';
import { makeItem } from '../manifest.js';
import { mustExec } from '../ctx.js';

const VENDOR = /^(OneDrive|BraveSoftware|Zoom|RtkAud|MicrosoftEdge|Google|Opera)/i;
// No Export-ScheduledTask here: running it for every task on the system just
// to populate collect() output is wasteful, and the XML (which can carry
// RunAs/credential settings) shouldn't sit in item.data/manifest.json any
// longer than it has to. stage() re-exports it, only for selected items.
const TASKS_PS = `Get-ScheduledTask | Where-Object TaskPath -eq '\\' | ForEach-Object { [pscustomobject]@{ Name=$_.TaskName; Execute=$_.Actions[0].Execute; Arguments=$_.Actions[0].Arguments; WorkingDirectory=$_.Actions[0].WorkingDirectory; Enabled=($_.State -ne 'Disabled') } } | ConvertTo-Json -Depth 4`;
const NODE_RE = /node(?:\.exe)?"*\s+"*([^"\r\n]+?\.(?:js|cjs|mjs))/i;

export const startupDir = (ctx) => path.join(ctx.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

const mk = (id, kind, title, data, singleton) =>
  makeItem({ id, collector: 'services', kind, title, data: { ...data, singleton, defaultOwner: singleton ? 'old' : 'both' } });

function serveMap(ctx) {
  const r = ctx.exec('tailscale', ['serve', 'status', '--json']);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  const web = JSON.parse(r.stdout).Web ?? {};
  return Object.entries(web).flatMap(([host, v]) => {
    const proxy = v.Handlers?.['/']?.Proxy ?? '';
    const local = Number(/:(\d+)\/?$/.exec(proxy)?.[1]);
    const https = Number(host.split(':').at(-1));
    return local && https ? [{ https, local }] : [];
  });
}

export function collect(ctx) {
  if (ctx.platform !== 'win32') return [];
  const items = [];
  const tasks = JSON.parse(mustExec(ctx, 'pwsh', ['-NoProfile', '-Command', TASKS_PS]) || '[]');
  for (const t of [].concat(tasks)) {
    if (VENDOR.test(t.Name)) continue;
    items.push(mk(`svc:task:${t.Name}`, 'scheduled-task', t.Name,
      { name: t.Name, execute: t.Execute, arguments: t.Arguments, workingDirectory: t.WorkingDirectory, enabled: t.Enabled }, true));
  }
  const serves = serveMap(ctx);
  const usedServe = new Set();
  const sd = startupDir(ctx);
  for (const f of fs.existsSync(sd) ? fs.readdirSync(sd) : []) {
    if (f.endsWith('.disabled') || f === 'desktop.ini') continue;
    const abs = path.join(sd, f);
    const base = f.replace(/\.[^.]+$/, '');
    const content = f.toLowerCase().endsWith('.vbs') ? fs.readFileSync(abs, 'utf8') : '';
    const m = NODE_RE.exec(content);
    if (m) {
      const scriptAbs = path.isAbsolute(m[1]) ? m[1] : null;
      if (!scriptAbs || !fs.existsSync(scriptAbs)) {
        items.push(mk(`svc:startup:${f}`, 'startup', f, { file: f, note: `node script not resolvable: ${m[1]}` }, true));
        continue;
      }
      const src = fs.readFileSync(scriptAbs, 'utf8');
      const port = Number(/const\s+PORT\s*=\s*(\d+)/.exec(src)?.[1]) || null;
      const serve = serves.find((s) => s.local === port);
      if (serve) usedServe.add(serve.https);
      items.push(mk(`svc:app:${base}`, 'node-app', base,
        { file: f, dir: path.dirname(scriptAbs), script: path.basename(scriptAbs), port, httpsPort: serve?.https ?? null },
        /api\.telegram\.org|getUpdates/.test(src)));
      continue;
    }
    items.push(mk(`svc:startup:${f}`, 'startup', f, { file: f }, true));
  }
  for (const s of serves) {
    if (!usedServe.has(s.https)) items.push(mk(`svc:serve:${s.https}`, 'serve', `tailscale :${s.https} -> ${s.local}`, { httpsPort: s.https, port: s.local }, false));
  }
  if (fs.existsSync(path.join(ctx.home, '.cloudflared', 'config.yml'))) items.push(mk('svc:cloudflared', 'cloudflared', 'cloudflared tunnel', {}, true));
  return items;
}

export function stage(ctx, item, stageRoot) {
  const out = path.join(stageRoot, 'services', item.id.replace(/[:]/g, '_'));
  fs.mkdirSync(out, { recursive: true });
  if (item.kind === 'node-app' || item.kind === 'startup') fs.copyFileSync(path.join(startupDir(ctx), item.data.file), path.join(out, item.data.file));
  if (item.kind === 'scheduled-task') {
    const xml = mustExec(ctx, 'pwsh', ['-NoProfile', '-Command', `Export-ScheduledTask -TaskName '${item.data.name.replace(/'/g, "''")}'`]);
    fs.writeFileSync(path.join(out, 'task.xml'), xml);
  }
}
