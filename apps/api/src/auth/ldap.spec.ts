import { describe, expect, it } from 'vitest';
import { adTransportProblem, escapeFilter, explainSearchError, normalizeUsername } from './ldap.js';

describe('normalizeUsername', () => {
  const suffix = 'sharbatlyfruit.com';
  it.each([
    ['mohamed.tag', 'mohamed.tag@sharbatlyfruit.com'],
    ['  Mohamed.Tag ', 'mohamed.tag@sharbatlyfruit.com'],
    ['mohamed.tag@sharbatlyfruit.com', 'mohamed.tag@sharbatlyfruit.com'],
    ['MOHAMED.TAG@SharbatlyFruit.com', 'mohamed.tag@sharbatlyfruit.com'],
    ['SHARBATLY\\mohamed.tag', 'mohamed.tag@sharbatlyfruit.com'],
    ['mohamed.tag@shrabtlyfruit.com', 'mohamed.tag@sharbatlyfruit.com'], // mistyped domain
    ['mohamed.tag@shrabatlyfruit.com', 'mohamed.tag@sharbatlyfruit.com'],
  ])('%s → %s', (input, upn) => expect(normalizeUsername(input, suffix)).toBe(upn));
});

describe('escapeFilter', () => {
  it('neutralises filter injection', () => {
    expect(escapeFilter('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
    expect(escapeFilter('a\\b')).toBe('a\\5cb');
  });
  it('leaves normal names alone', () => expect(escapeFilter('mohamed.tag')).toBe('mohamed.tag'));
});

describe('explainSearchError', () => {
  it('turns an AD referral into a Base DN message', () => {
    const e = explainSearchError(new Error("0000202B: RefErr: DSID-0310084B, data 0, 1 access points ref 1: 'sharbatly.com' Code: 0xa"), 'OU=Users,DC=sharbatly,DC=com');
    expect(e.message).toMatch(/Base DN "OU=Users,DC=sharbatly,DC=com" is not in this directory/);
  });
});

describe('adTransportProblem (F08)', () => {
  it('allows anything on a developer PC', () => {
    expect(adTransportProblem({ url: 'ldap://dc:389', allowSelfSigned: true }, 'development')).toBeNull();
  });
  it('in production refuses ldap:// and self-signed certificates', () => {
    expect(adTransportProblem({ url: 'ldap://dc:389', allowSelfSigned: false }, 'production')).toMatch(/ldaps/);
    expect(adTransportProblem({ url: 'ldaps://dc:636', allowSelfSigned: true }, 'production')).toMatch(/self-signed/);
    expect(adTransportProblem({ url: 'LDAPS://dc:636', allowSelfSigned: false }, 'production')).toBeNull();
  });
});
