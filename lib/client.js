import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function check(r, what) {
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status} ${await r.text()}`);
  return r;
}

export async function fetchManifest(from, code) {
  return (await check(await fetch(`${from}/api/bundle/manifest`, { headers: { 'x-mkit-code': code } }), 'pairing')).json();
}

export async function downloadBlob(from, token, file) {
  const r = await check(await fetch(`${from}/api/bundle/blob`, { headers: { authorization: `Bearer ${token}` } }), 'bundle download');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file));
}

export async function report(remote, payload) {
  await check(await fetch(`${remote.from}/api/report`, { method: 'POST', headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) }), 'report');
}

export async function fetchOwners(remote) {
  return (await check(await fetch(`${remote.from}/api/owners`, { headers: { authorization: `Bearer ${remote.token}` } }), 'owners')).json();
}
