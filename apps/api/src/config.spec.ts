import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, productionProblems } from './config.js';

const base = { DB_SERVER: 'sql', DB_NAME: 'supplychain', SETTINGS_ENCRYPTION_KEY: 'k', SESSION_SECRET: 'x'.repeat(40) };
const load = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
  return loadConfig();
};

afterEach(() => vi.unstubAllEnvs());

describe('TRUST_PROXY', () => {
  it('is false by default, true, or a list of proxy addresses', () => {
    vi.stubEnv('TRUST_PROXY', '');
    expect(load({}).TRUST_PROXY).toBe(false);
    expect(load({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(load({ TRUST_PROXY: '10.0.0.5, 10.0.1.0/24,::1,loopback' }).TRUST_PROXY).toEqual(['10.0.0.5', '10.0.1.0/24', '::1', 'loopback']);
  });
  it('refuses anything else', () => {
    expect(() => load({ TRUST_PROXY: 'yes please' })).toThrow(/TRUST_PROXY/);
  });
});

describe('productionProblems (F08)', () => {
  const prod = { NODE_ENV: 'production', TLS_PFX_FILE: 'c:/certs/a.pfx', DB_ENCRYPT: 'true', HOST: '0.0.0.0' };
  it('a correctly set up server starts; a developer PC is never checked', () => {
    expect(productionProblems(load(prod), 'production')).toEqual([]);
    expect(productionProblems(load({ DB_ENCRYPT: 'false', TRUST_PROXY: 'true', AD_URL: 'ldap://dc' }), 'development')).toEqual([]);
  });
  it('refuses TRUST_PROXY=true unless only this machine can connect', () => {
    expect(productionProblems(load({ ...prod, TLS_PFX_FILE: '', TRUST_PROXY: 'true' }), 'production').join()).toMatch(/HOST=127\.0\.0\.1/);
    expect(productionProblems(load({ ...prod, TLS_PFX_FILE: '', TRUST_PROXY: 'true', HOST: '127.0.0.1' }), 'production')).toEqual([]);
    expect(productionProblems(load({ ...prod, TLS_PFX_FILE: '', TRUST_PROXY: '10.0.0.5' }), 'production')).toEqual([]);
  });
  it('refuses an unencrypted database connection and ldap://', () => {
    expect(productionProblems(load({ ...prod, DB_ENCRYPT: 'false' }), 'production').join()).toMatch(/DB_ENCRYPT/);
    expect(productionProblems(load({ ...prod, AD_URL: 'ldap://dc:389' }), 'production').join()).toMatch(/AD_URL/);
  });
});
