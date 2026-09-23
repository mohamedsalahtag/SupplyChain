import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret.js';

const key = randomBytes(32).toString('base64');

describe('settings secrets', () => {
  it('round-trips and never stores the plain text', () => {
    const stored = encryptSecret('s3cret!', key);
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain('s3cret');
    expect(decryptSecret(stored, key)).toBe('s3cret!');
  });

  it('fails with the wrong key', () => {
    const stored = encryptSecret('s3cret!', key);
    expect(() => decryptSecret(stored, randomBytes(32).toString('base64'))).toThrow();
  });
});
