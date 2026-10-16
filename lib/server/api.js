import fs from 'node:fs';
import path from 'node:path';
import { createPairing } from './pairing.js';
import { loadSelections, saveSelections, resolve } from '../selections.js';
import { summarize } from '../manifest.js';

const OWNERS = ['old', 'new', 'both'];

export function createApi({ ctx, dataDir, scanFn, exportFn, localToggle }) {
  const scanFile = path.join(dataDir, 'scan.json');
  const selFile = path.join(dataDir, 'selections.json');
  const bundleDir = path.join(dataDir, 'bundle');
  const pairing = createPairing(dataDir);
  const job = { state: 'idle', step: null, error: null, manifest: null };

  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
  const MAX_BODY = 8 * 1024 * 1024; // a machine report with every item is well under 1 MB
  const body = (req) => new Promise((ok, bad) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > MAX_BODY) { req.destroy(); bad(new Error('request body too large')); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
  const inventory = () => (fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : null);
  const owners = () => {
    const inv = inventory(); const sel = loadSelections(selFile);
    return Object.fromEntries((inv?.items ?? []).filter((i) => i.collector === 'services').map((i) => [i.id, sel.services[i.id] ?? i.data.defaultOwner]));
  };

  return function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    (async () => {
      try {
        if (p === '/api/scan' && req.method === 'GET') { const inv = inventory(); return inv ? send(res, 200, inv) : send(res, 404, { error: 'no scan yet' }); }
        if (p === '/api/scan' && req.method === 'POST') {
          const inv = scanFn(ctx); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(scanFile, JSON.stringify(inv)); return send(res, 200, inv);
        }
        if (p === '/api/selections' && req.method === 'GET') return send(res, 200, loadSelections(selFile));
        if (p === '/api/selections' && req.method === 'PUT') {
          const sel = await body(req); const inv = inventory();
          if (inv) resolve(inv, { projects: sel.projects ?? {}, services: sel.services ?? {}, excluded: sel.excluded ?? [] });
          saveSelections(selFile, sel); return send(res, 200, loadSelections(selFile));
        }
        if (p === '/api/export' && req.method === 'GET') return send(res, 200, job);
        if (p === '/api/export' && req.method === 'POST') {
          if (job.state === 'running') return send(res, 409, { error: 'export already running' });
          const inv = inventory(); if (!inv) return send(res, 409, { error: 'scan first' });
          const { passphrase } = await body(req);
          if (!passphrase || passphrase.length < 8) return send(res, 400, { error: 'passphrase must be at least 8 characters' });
          Object.assign(job, { state: 'running', step: 'start', error: null, manifest: null });
          fs.rmSync(bundleDir, { recursive: true, force: true });
          exportFn({ ctx, inventory: inv, selections: loadSelections(selFile), passphrase, outDir: bundleDir, onStep: (s) => (job.step = s) })
            .then((m) => Object.assign(job, { state: 'done', manifest: { createdAt: m.createdAt, blobSize: m.blobSize, items: m.items.length } }))
            .catch((e) => Object.assign(job, { state: 'failed', error: e.message }));
          return send(res, 202, job);
        }
        if (p === '/api/pair' && req.method === 'POST') {
          if (!fs.existsSync(path.join(bundleDir, 'manifest.json'))) return send(res, 409, { error: 'export a bundle first' });
          return send(res, 200, pairing.newCode());
        }
        if (p === '/api/bundle/manifest' && req.method === 'GET') {
          const m = pairing.consume(req.headers['x-mkit-code']);
          if (!m) return send(res, 403, { error: 'invalid or expired pairing code' });
          return send(res, 200, { manifest: JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')), machineId: m.id, token: m.token });
        }
        const machine = pairing.byToken(req.headers.authorization);
        if (p === '/api/bundle/blob' && req.method === 'GET') {
          if (!machine) return send(res, 401, { error: 'unauthorized' });
          const f = path.join(bundleDir, 'bundle.tar.gz.age');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size });
          // a re-export deletes the bundle dir; without this handler a mid-download ENOENT crashes the server
          fs.createReadStream(f).on('error', () => res.destroy()).pipe(res); return true;
        }
        if (p === '/api/report' && req.method === 'POST') {
          if (!machine) return send(res, 401, { error: 'unauthorized' });
          const b = await body(req);
          pairing.updateMachine(machine.id, { hostname: b.hostname, platform: b.platform, items: b.items, reportedAt: new Date().toISOString() });
          return send(res, 200, { ok: true });
        }
        if (p === '/api/machines' && req.method === 'GET') {
          return send(res, 200, pairing.machines().map(({ token, ...m }) => ({ ...m, counts: summarize(Object.values(m.items ?? {})) })));
        }
        if (p === '/api/owners' && req.method === 'GET') {
          if (!machine) return send(res, 401, { error: 'unauthorized' });
          return send(res, 200, { services: owners() });
        }
        const om = /^\/api\/owners\/(.+)$/.exec(p);
        if (om && req.method === 'PUT') {
          const id = decodeURIComponent(om[1]);
          const { owner } = await body(req);
          if (!OWNERS.includes(owner)) return send(res, 400, { error: `owner must be one of ${OWNERS.join(', ')}` });
          const item = inventory()?.items.find((i) => i.id === id);
          if (!item) return send(res, 404, { error: `unknown service ${id}` });
          const before = owners()[id];
          const wasOld = before !== 'new'; const isOld = owner !== 'new';
          // toggle first: if it throws, the owner is not saved, so the dashboard never shows a change that didn't happen
          const note = wasOld !== isOld ? (await localToggle(item, isOld)) ?? null : null;
          const sel = loadSelections(selFile); sel.services[id] = owner; saveSelections(selFile, sel);
          return send(res, 200, { id, owner, note });
        }
        return send(res, 404, { error: 'not found' });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    })();
    return true;
  };
}
