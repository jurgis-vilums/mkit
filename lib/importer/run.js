import fs from 'node:fs';
import path from 'node:path';
import { COLLECTORS } from '../manifest.js';

const DONE = new Set(['ok', 'needs-agent', 'todo']);

export function loadState(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { items: {} };
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export async function runImport({ tctx, manifest, payloadRoot, stateFile, restorers, onItem = () => {} }) {
  const state = loadState(stateFile);
  const ordered = [...manifest.items].sort((a, b) => COLLECTORS.indexOf(a.collector) - COLLECTORS.indexOf(b.collector));
  for (const it of ordered) {
    if (DONE.has(state.items[it.id]?.status)) continue;
    let r;
    try {
      r = await restorers[it.collector](tctx, it, payloadRoot, manifest.source);
    } catch (e) {
      r = { status: 'failed', reason: e.message };
    }
    state.items[it.id] = { status: r.status, reason: r.reason ?? null, title: it.title, collector: it.collector, at: new Date().toISOString() };
    saveState(stateFile, state);
    onItem(it, r);
  }
  return state;
}
