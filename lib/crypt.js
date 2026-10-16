import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { Encrypter, Decrypter } from 'age-encryption';

export async function packEncrypted(srcDir, outFile, passphrase, { workFactor } = {}) {
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  if (workFactor) e.setScryptWorkFactor(workFactor);
  const tarStream = Readable.from(tar.c({ gzip: true, cwd: srcDir, portable: true, strict: true }, fs.readdirSync(srcDir)));
  const enc = await e.encrypt(Readable.toWeb(tarStream));
  await pipeline(Readable.fromWeb(enc), fs.createWriteStream(outFile));
}

export async function unpackEncrypted(inFile, destDir, passphrase) {
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  // decrypt() parses the header and unwraps the file key here: a wrong passphrase throws before any output
  const dec = await d.decrypt(Readable.toWeb(fs.createReadStream(inFile)));
  fs.mkdirSync(destDir, { recursive: true });
  await pipeline(Readable.fromWeb(dec), tar.x({ cwd: destDir, strict: true }));
}

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}
