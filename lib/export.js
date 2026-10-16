import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COLLECTOR_MODULES } from './scan.js';
import { resolve } from './selections.js';
import { packEncrypted, sha256File } from './crypt.js';

export async function exportBundle({ ctx, inventory, selections, passphrase, outDir, workFactor, onStep = () => {} }) {
  if (!passphrase || (passphrase.length < 8 && !workFactor)) throw new Error('passphrase must be at least 8 characters');
  const items = resolve(inventory, selections);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mkit-stage-'));
  fs.chmodSync(stageRoot, 0o700); // staged secrets/keys sit here briefly; keep it private
  try {
    for (const it of items) {
      onStep(`stage ${it.id}`);
      COLLECTOR_MODULES[it.collector].stage(ctx, it, stageRoot);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const blob = path.join(outDir, 'bundle.tar.gz.age');
    onStep('encrypt');
    await packEncrypted(stageRoot, blob, passphrase, { workFactor });
    const manifest = { version: 1, createdAt: new Date().toISOString(), source: inventory.source,
      blobSha256: sha256File(blob), blobSize: fs.statSync(blob).size, items };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    onStep('done');
    return manifest;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}
