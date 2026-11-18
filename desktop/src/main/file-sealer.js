/**
 * Sealing API keys on a server, where there's no Keychain or DPAPI for Electron's safeStorage to use (a Linux box
 * with no desktop has no keyring, and safeStorage would fall back to a key that's the same for everyone).
 *
 * AES-256-GCM with a key of the server's own, made on first use and kept beside the settings, readable by its owner
 * only. That keeps keys out of a copied settings file or a backup that leaves the key behind; it doesn't keep them
 * from someone who can read the whole data folder, which nothing on the same disk could.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 'v1';

/** The sealing key in `file`, made if there's none yet. */
function keyIn(file) {
  try {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
    throw new Error(`${file} isn’t a sealing key`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 'wx': never over one another process just made.
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

/** `{ seal, unseal }` for storage.js, with the key kept at `file`. */
export function createFileSealer(file) {
  const key = keyIn(file);
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), sealed.toString('base64')].join('.');
    },
    unseal(sealed) {
      const [version, iv, tag, body] = String(sealed).split('.');
      if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('Not sealed by this server');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
    }
  };
}
