/** AES-256-GCM for secrets stored in app.Setting. Format: enc:v1:<iv>:<tag>:<ciphertext> (base64). */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function key(base64Key: string): Buffer {
  const k = Buffer.from(base64Key, 'base64');
  if (k.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return k;
}

export function encryptSecret(plain: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(base64Key), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

export function decryptSecret(stored: string, base64Key: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error('Stored secret is not encrypted');
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(base64Key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
