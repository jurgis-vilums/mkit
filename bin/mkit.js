#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx } from '../lib/ctx.js';
import { scan } from '../lib/scan.js';
import { exportBundle } from '../lib/export.js';
import { loadSelections } from '../lib/selections.js';
import { unpackEncrypted, sha256File } from '../lib/crypt.js';
import { runImport, loadState, saveState } from '../lib/importer/run.js';
import { RESTORERS } from '../lib/importer/index.js';
import { unitFor, enableService, disableService } from '../lib/importer/services.js';
import { rewritePath } from '../lib/rewrite.js';
import { summarize, STATUSES } from '../lib/manifest.js';
import { askSecret } from '../lib/prompt.js';
import * as client from '../lib/client.js';

const KIT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELP = `mkit — Claude Code machine migration kit
  mkit scan [--json]
  mkit export --out <dir> [--selections <file>]
  mkit import (--from <url> --code <code> | --bundle <dir> | --resume)
  mkit status [--json]
  mkit mark <item-id> <ok|failed|needs-agent|todo> [reason...]
  mkit report
  mkit services sync
Env: MKIT_PASSPHRASE (non-interactive passphrase), MKIT_HOME (target home override, tests/E2E)`;

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; }
    else out._.push(argv[i]);
  }
  return out;
}

const ctx = makeCtx(process.env.MKIT_HOME ? { home: process.env.MKIT_HOME } : {});
const mk = path.join(ctx.home, '.mkit');
const files = { state: path.join(mk, 'state.json'), manifest: path.join(mk, 'manifest.json'), blob: path.join(mk, 'bundle.tar.gz.age'),
  payload: path.join(mk, 'payload'), remote: path.join(mk, 'remote.json'), runbook: path.join(mk, 'RUNBOOK.md') };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function pushReport() {
  if (!fs.existsSync(files.remote)) return;
  const st = loadState(files.state);
  await client.report(readJson(files.remote), { hostname: os.hostname(), platform: ctx.platform, items: st.items });
}

function printSummary(st) {
  const items = Object.values(st.items);
  console.log(Object.entries(summarize(items)).filter(([k]) => k !== 'pending').map(([k, v]) => `${k}: ${v}`).join('  '));
  for (const [id, it] of Object.entries(st.items)) if (it.status !== 'ok') console.log(`  [${it.status}] ${id} — ${it.reason}`);
  return items.some((i) => i.status === 'failed') ? 1 : 0;
}

async function cmdImport(a) {
  fs.mkdirSync(mk, { recursive: true });
  if (a.from) {
    if (!a.code) throw new Error('--code required with --from');
    const from = String(a.from).replace(/\/$/, '');
    const { manifest, token, machineId } = await client.fetchManifest(from, a.code);
    fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(files.remote, JSON.stringify({ from, token, machineId }));
    console.log(`downloading bundle (${(manifest.blobSize / 1e6).toFixed(1)} MB)…`);
    await client.downloadBlob(from, token, files.blob);
  } else if (a.bundle) {
    fs.copyFileSync(path.join(a.bundle, 'manifest.json'), files.manifest);
    fs.copyFileSync(path.join(a.bundle, 'bundle.tar.gz.age'), files.blob);
  } else if (!a.resume) throw new Error('one of --from, --bundle, --resume required');
  const manifest = readJson(files.manifest);
  if (!a.resume) {
    if (sha256File(files.blob) !== manifest.blobSha256) throw new Error('bundle checksum mismatch');
    const pass = await askSecret('Bundle passphrase: ');
    fs.rmSync(files.payload, { recursive: true, force: true });
    try { await unpackEncrypted(files.blob, files.payload, pass); }
    catch (e) { console.error(`cannot decrypt bundle: ${e.message}`); return 2; }
  }
  fs.copyFileSync(path.join(KIT, 'RUNBOOK.md'), files.runbook);
  const st = await runImport({ tctx: ctx, manifest, payloadRoot: files.payload, stateFile: files.state, restorers: RESTORERS,
    onItem: (it, r) => console.log(`[${r.status}] ${it.id}${r.reason ? ` — ${r.reason}` : ''}`) });
  await pushReport();
  const code = printSummary(st);
  console.log(`\nNext: claude "Read ${files.runbook} and follow it"`);
  return code;
}

async function cmdServicesSync() {
  const remote = readJson(files.remote);
  const { services } = await client.fetchOwners(remote);
  const manifest = readJson(files.manifest);
  const st = loadState(files.state);
  const node = ctx.exec(ctx.platform === 'win32' ? 'where' : 'which', ['node']).stdout.split(/\r?\n/)[0].trim();
  for (const it of manifest.items.filter((i) => i.kind === 'node-app' && st.items[i.id]?.status === 'ok')) {
    const owner = services[it.id];
    const was = it.data.owner;
    if (!owner || owner === was) continue;
    const item = { ...it, data: { ...it.data, owner } };
    const dir = rewritePath(it.data.dir, manifest.source, { home: ctx.home, platform: ctx.platform });
    const unit = unitFor(item, ctx, dir, node);
    const on = owner !== 'old';
    if (on) enableService(ctx, item, unit.path); else disableService(ctx, item, unit.path, dir);
    it.data.owner = owner;
    console.log(`${it.id}: ${was} → ${owner} (${on ? 'enabled' : 'disabled'})`);
  }
  fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));
  for (const it of manifest.items.filter((i) => i.collector === 'services' && i.kind !== 'node-app' && services[i.id] && services[i.id] !== i.data.owner)) {
    console.log(`${it.id}: owner now ${services[it.id]} — not a node-app, handle via RUNBOOK`);
  }
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!cmd || cmd === 'help' || a.help) { console.log(HELP); return 0; }
  if (cmd === 'scan') {
    const inv = scan(ctx);
    if (a.json) console.log(JSON.stringify(inv, null, 2));
    else for (const c of ['claude', 'secrets', 'tools', 'projects', 'services', 'shell']) console.log(`${c}: ${inv.items.filter((i) => i.collector === c).length}`);
    return 0;
  }
  if (cmd === 'export') {
    if (!a.out) throw new Error('--out required');
    const pass = await askSecret('New bundle passphrase: ');
    if (!process.env.MKIT_PASSPHRASE && pass !== await askSecret('Repeat passphrase: ')) throw new Error('passphrases differ');
    const sel = loadSelections(a.selections ?? path.join(KIT, 'data', 'selections.json'));
    const m = await exportBundle({ ctx, inventory: scan(ctx), selections: sel, passphrase: pass, outDir: a.out, onStep: (s) => console.log(s) });
    console.log(`bundle: ${m.items.length} items, ${(m.blobSize / 1e6).toFixed(1)} MB → ${a.out}`);
    return 0;
  }
  if (cmd === 'import') return cmdImport(a);
  if (cmd === 'status') {
    const st = loadState(files.state);
    if (a.json) { console.log(JSON.stringify(st, null, 2)); return 0; }
    return printSummary(st);
  }
  if (cmd === 'mark') {
    const [id, status, ...why] = a._;
    if (!STATUSES.includes(status) || status === 'pending') throw new Error(`status must be ok|failed|needs-agent|todo`);
    const st = loadState(files.state);
    if (!st.items[id]) throw new Error(`unknown item ${id}`);
    if ((status === 'failed' || status === 'needs-agent') && !why.length) throw new Error('reason required');
    st.items[id] = { ...st.items[id], status, reason: why.join(' ') || null, at: new Date().toISOString(), by: 'agent' };
    saveState(files.state, st);
    await pushReport();
    return 0;
  }
  if (cmd === 'report') { await pushReport(); return 0; }
  if (cmd === 'services' && a._[0] === 'sync') return cmdServicesSync();
  console.error(HELP);
  return 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`mkit: ${e.message}`); process.exit(1); });
