import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TTL_MS = 30 * 60 * 1000;

const read = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

export function createPairing(dataDir, now = () => Date.now()) {
  const pf = path.join(dataDir, 'pairing.json');
  const mf = path.join(dataDir, 'machines.json');
  return {
    newCode() {
      const code = Array.from(crypto.randomBytes(8), (b) => ALPHA[b % ALPHA.length]).join('');
      const entry = { code, expiresAt: now() + TTL_MS };
      write(pf, entry);
      return { code, expiresAt: new Date(entry.expiresAt).toISOString() };
    },
    consume(code) {
      const p = read(pf, null);
      if (!p || !code || p.code !== code || p.expiresAt < now()) return null;
      fs.rmSync(pf);
      const machine = { id: crypto.randomUUID(), token: crypto.randomBytes(24).toString('hex'), pairedAt: new Date(now()).toISOString(), items: {} };
      write(mf, [...read(mf, []), machine]);
      return machine;
    },
    byToken(header) {
      const t = /^Bearer (\w+)$/.exec(header ?? '')?.[1];
      return t ? read(mf, []).find((m) => m.token === t) ?? null : null;
    },
    updateMachine(id, patch) {
      const all = read(mf, []).map((m) => (m.id === id ? { ...m, ...patch } : m));
      write(mf, all);
    },
    machines: () => read(mf, []),
  };
}
